import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { getDb } from '@wa-gateway/db';
import { ErrorCode } from '@wa-gateway/types';
import type { CreateInstanceBody, UpdateSettingsBody } from '@wa-gateway/types';

const createInstanceSchema = {
  body: {
    type: 'object',
    properties: {
      webhookUrl: { type: 'string', format: 'uri' },
      settings: {
        type: 'object',
        properties: {
          delaySend: { type: 'number', minimum: 0 },
          keepOnline: { type: 'boolean' },
        },
      },
    },
  },
};

const updateSettingsSchema = {
  body: {
    type: 'object',
    properties: {
      webhookUrl: { type: 'string', format: 'uri' },
      delaySend: { type: 'number', minimum: 0 },
      keepOnline: { type: 'boolean' },
    },
  },
};

export async function instanceRoutes(app: FastifyInstance) {

  // POST /instances
  app.post('/', { schema: createInstanceSchema }, async (
    request: FastifyRequest<{ Body: CreateInstanceBody }>,
    reply: FastifyReply,
  ) => {
    // Only master key or instance key can create
    const db = getDb();
    const apiKey = `wag_${randomUUID().replace(/-/g, '')}`;

    if (request.body.webhookUrl && !isAllowedWebhookUrl(request.body.webhookUrl)) {
      return reply.status(400).send({ error: 'INVALID_WEBHOOK_URL', message: 'Webhook URL must not point to localhost or private networks', code: 400 });
    }

    const instance = await db.instance.create({
      data: {
        apiKey,
        status: 'STARTING',
        webhookUrl: request.body.webhookUrl || null,
        settings: request.body.settings || {},
      },
    });

    await db.auditLog.create({
      data: { instanceId: instance.id, action: 'create_instance', details: { webhookUrl: instance.webhookUrl }, ip: request.ip },
    });

    // Signal worker to start Baileys session
    await app.redis.publish('instance:commands', JSON.stringify({ action: 'start', instanceId: instance.id }));

    return reply.status(201).send({
      id: instance.id,
      apiKey,
      status: instance.status,
      webhookUrl: instance.webhookUrl,
      createdAt: instance.createdAt,
    });
  });

  // GET /instances
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const db = getDb();
    if (request.isMasterKey) {
      return db.instance.findMany({
        select: { id: true, status: true, phoneNumber: true, webhookUrl: true, settings: true, createdAt: true },
      });
    }
    return db.instance.findMany({
      where: { id: request.instanceId },
      select: { id: true, status: true, phoneNumber: true, webhookUrl: true, settings: true, createdAt: true },
    });
  });

  // GET /instances/:id
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const db = getDb();
    const instance = await db.instance.findUnique({
      where: { id: request.params.id },
      select: { id: true, status: true, phoneNumber: true, webhookUrl: true, settings: true, createdAt: true, updatedAt: true },
    });
    if (!instance) return reply.status(404).send({ error: ErrorCode.INSTANCE_NOT_FOUND, message: 'Instance not found', code: 404 });
    if (!request.isMasterKey && request.params.id !== request.instanceId) {
      return reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
    }
    return instance;
  });

  // DELETE /instances/:id
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    if (!request.isMasterKey && request.params.id !== request.instanceId) {
      return reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
    }
    const db = getDb();

    // Signal worker to stop session
    await app.redis.publish('instance:commands', JSON.stringify({ action: 'stop', instanceId: request.params.id }));

    await db.instance.delete({ where: { id: request.params.id } });
    await db.auditLog.create({ data: { action: 'delete_instance', details: { instanceId: request.params.id }, ip: request.ip } });
    return { success: true };
  });

  // GET /instances/:id/qr — fetch from Redis
  app.get<{ Params: { id: string } }>('/:id/qr', async (request, reply) => {
    if (!request.isMasterKey && request.params.id !== request.instanceId) {
      return reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
    }

    const db = getDb();
    const instance = await db.instance.findUnique({ where: { id: request.params.id } });
    if (!instance) return reply.status(404).send({ error: ErrorCode.INSTANCE_NOT_FOUND, message: 'Instance not found', code: 404 });

    if (instance.status !== 'QR_READY') {
      return reply.status(409).send({ error: ErrorCode.QR_NOT_READY, message: `QR not available. Status: ${instance.status}`, code: 409 });
    }

    // Fetch QR from Redis (set by worker)
    const qr = await app.redis.get(`qr:${request.params.id}`);
    if (!qr) {
      return reply.status(409).send({ error: ErrorCode.QR_NOT_READY, message: 'QR expired. Waiting for new QR...', code: 409 });
    }

    return { type: 'qr', image: qr };
  });

  // GET /instances/:id/status
  app.get<{ Params: { id: string } }>('/:id/status', async (request, reply) => {
    if (!request.isMasterKey && request.params.id !== request.instanceId) {
      return reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
    }
    const db = getDb();
    const instance = await db.instance.findUnique({
      where: { id: request.params.id },
      select: { id: true, status: true, phoneNumber: true },
    });
    if (!instance) return reply.status(404).send({ error: ErrorCode.INSTANCE_NOT_FOUND, message: 'Instance not found', code: 404 });
    return { status: instance.status, phoneNumber: instance.phoneNumber };
  });

  // POST /instances/:id/logout
  app.post<{ Params: { id: string } }>('/:id/logout', async (request, reply) => {
    if (!request.isMasterKey && request.params.id !== request.instanceId) {
      return reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
    }
    // Signal worker to logout
    await app.redis.publish('instance:commands', JSON.stringify({ action: 'logout', instanceId: request.params.id }));

    const db = getDb();
    await db.auditLog.create({ data: { instanceId: request.params.id, action: 'logout_instance', ip: request.ip } });
    return { success: true };
  });

  // PUT /instances/:id/settings
  app.put<{ Params: { id: string }; Body: UpdateSettingsBody }>('/:id/settings', { schema: updateSettingsSchema }, async (request, reply) => {
    if (!request.isMasterKey && request.params.id !== request.instanceId) {
      return reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
    }
    if (request.body.webhookUrl && !isAllowedWebhookUrl(request.body.webhookUrl)) {
      return reply.status(400).send({ error: 'INVALID_WEBHOOK_URL', message: 'Webhook URL must not point to localhost or private networks', code: 400 });
    }

    const db = getDb();
    const instance = await db.instance.findUnique({ where: { id: request.params.id } });
    if (!instance) return reply.status(404).send({ error: ErrorCode.INSTANCE_NOT_FOUND, message: 'Instance not found', code: 404 });

    const s = (instance.settings as Record<string, unknown>) || {};
    if (request.body.delaySend !== undefined) s.delaySend = request.body.delaySend;
    if (request.body.keepOnline !== undefined) s.keepOnline = request.body.keepOnline;

    const updated = await db.instance.update({
      where: { id: request.params.id },
      data: { webhookUrl: request.body.webhookUrl ?? instance.webhookUrl, settings: s },
    });
    return { id: updated.id, webhookUrl: updated.webhookUrl, settings: updated.settings };
  });
}

// === SSRF Protection ===
function isAllowedWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const h = parsed.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return false;
    if (/^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^0\./.test(h)) return false;
    if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') return false;
    return true;
  } catch { return false; }
}
