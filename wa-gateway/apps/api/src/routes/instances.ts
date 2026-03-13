import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { getDb } from '@wa-gateway/db';
import { ErrorCode, InstanceStatus } from '@wa-gateway/types';
import type { CreateInstanceBody, UpdateSettingsBody } from '@wa-gateway/types';

// JSON Schemas for validation
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

  // POST /instances — Create new instance
  app.post('/', { schema: createInstanceSchema }, async (
    request: FastifyRequest<{ Body: CreateInstanceBody }>,
    reply: FastifyReply,
  ) => {
    const db = getDb();
    const apiKey = `wag_${randomUUID().replace(/-/g, '')}`;

    // Validate webhook URL against SSRF
    if (request.body.webhookUrl) {
      if (!isAllowedWebhookUrl(request.body.webhookUrl)) {
        return reply.status(400).send({
          error: 'INVALID_WEBHOOK_URL',
          message: 'Webhook URL must not point to localhost or private networks',
          code: 400,
        });
      }
    }

    const instance = await db.instance.create({
      data: {
        apiKey,
        status: 'STARTING',
        webhookUrl: request.body.webhookUrl || null,
        settings: request.body.settings || {},
      },
    });

    // Audit
    await db.auditLog.create({
      data: {
        instanceId: instance.id,
        action: 'create_instance',
        details: { webhookUrl: instance.webhookUrl },
        ip: request.ip,
      },
    });

    return reply.status(201).send({
      id: instance.id,
      apiKey,
      status: instance.status,
      webhookUrl: instance.webhookUrl,
      createdAt: instance.createdAt,
    });
  });

  // GET /instances — List all instances (for current auth key = current instance only)
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const db = getDb();
    const instances = await db.instance.findMany({
      where: { id: request.instanceId },
      select: {
        id: true,
        status: true,
        phoneNumber: true,
        webhookUrl: true,
        settings: true,
        createdAt: true,
      },
    });
    return instances;
  });

  // GET /instances/:id — Instance details
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const db = getDb();
    const instance = await db.instance.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        status: true,
        phoneNumber: true,
        webhookUrl: true,
        settings: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!instance) {
      return reply.status(404).send({
        error: ErrorCode.INSTANCE_NOT_FOUND,
        message: 'Instance not found',
        code: 404,
      });
    }

    // Check ownership
    if (request.params.id !== request.instanceId) {
      return reply.status(403).send({
        error: ErrorCode.FORBIDDEN,
        message: 'Access denied to this instance',
        code: 403,
      });
    }

    return instance;
  });

  // DELETE /instances/:id — Delete instance
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    if (request.params.id !== request.instanceId) {
      return reply.status(403).send({
        error: ErrorCode.FORBIDDEN,
        message: 'Access denied',
        code: 403,
      });
    }

    const db = getDb();
    await db.instance.delete({ where: { id: request.params.id } });

    await db.auditLog.create({
      data: {
        action: 'delete_instance',
        details: { instanceId: request.params.id },
        ip: request.ip,
      },
    });

    return { success: true };
  });

  // GET /instances/:id/qr — Get QR code
  app.get<{ Params: { id: string } }>('/:id/qr', async (request, reply) => {
    if (request.params.id !== request.instanceId) {
      return reply.status(403).send({
        error: ErrorCode.FORBIDDEN,
        message: 'Access denied',
        code: 403,
      });
    }

    const db = getDb();
    const instance = await db.instance.findUnique({
      where: { id: request.params.id },
    });

    if (!instance) {
      return reply.status(404).send({
        error: ErrorCode.INSTANCE_NOT_FOUND,
        message: 'Instance not found',
        code: 404,
      });
    }

    if (instance.status !== 'QR_READY') {
      return reply.status(409).send({
        error: ErrorCode.QR_NOT_READY,
        message: `QR not available. Current status: ${instance.status}`,
        code: 409,
      });
    }

    // QR will be provided by the worker service via Redis pub/sub
    // For now, return placeholder
    // TODO: integrate with Redis to get real QR from worker
    return {
      type: 'qr',
      message: 'QR generation is handled by the worker service. Connect via WebSocket or poll this endpoint.',
    };
  });

  // GET /instances/:id/status — Current connection status
  app.get<{ Params: { id: string } }>('/:id/status', async (request, reply) => {
    if (request.params.id !== request.instanceId) {
      return reply.status(403).send({
        error: ErrorCode.FORBIDDEN,
        message: 'Access denied',
        code: 403,
      });
    }

    const db = getDb();
    const instance = await db.instance.findUnique({
      where: { id: request.params.id },
      select: { id: true, status: true, phoneNumber: true },
    });

    if (!instance) {
      return reply.status(404).send({
        error: ErrorCode.INSTANCE_NOT_FOUND,
        message: 'Instance not found',
        code: 404,
      });
    }

    return { status: instance.status, phoneNumber: instance.phoneNumber };
  });

  // POST /instances/:id/logout — Logout (keep instance)
  app.post<{ Params: { id: string } }>('/:id/logout', async (request, reply) => {
    if (request.params.id !== request.instanceId) {
      return reply.status(403).send({
        error: ErrorCode.FORBIDDEN,
        message: 'Access denied',
        code: 403,
      });
    }

    const db = getDb();
    await db.instance.update({
      where: { id: request.params.id },
      data: { status: 'DISCONNECTED', phoneNumber: null },
    });

    // TODO: signal worker to disconnect Baileys session

    await db.auditLog.create({
      data: {
        instanceId: request.params.id,
        action: 'logout_instance',
        ip: request.ip,
      },
    });

    return { success: true };
  });

  // PUT /instances/:id/settings — Update settings
  app.put<{ Params: { id: string }; Body: UpdateSettingsBody }>('/:id/settings', {
    schema: updateSettingsSchema,
  }, async (request, reply) => {
    if (request.params.id !== request.instanceId) {
      return reply.status(403).send({
        error: ErrorCode.FORBIDDEN,
        message: 'Access denied',
        code: 403,
      });
    }

    if (request.body.webhookUrl && !isAllowedWebhookUrl(request.body.webhookUrl)) {
      return reply.status(400).send({
        error: 'INVALID_WEBHOOK_URL',
        message: 'Webhook URL must not point to localhost or private networks',
        code: 400,
      });
    }

    const db = getDb();
    const instance = await db.instance.findUnique({ where: { id: request.params.id } });
    if (!instance) {
      return reply.status(404).send({
        error: ErrorCode.INSTANCE_NOT_FOUND,
        message: 'Instance not found',
        code: 404,
      });
    }

    const currentSettings = (instance.settings as Record<string, unknown>) || {};
    const newSettings = { ...currentSettings };
    if (request.body.delaySend !== undefined) newSettings.delaySend = request.body.delaySend;
    if (request.body.keepOnline !== undefined) newSettings.keepOnline = request.body.keepOnline;

    const updated = await db.instance.update({
      where: { id: request.params.id },
      data: {
        webhookUrl: request.body.webhookUrl ?? instance.webhookUrl,
        settings: newSettings,
      },
    });

    return {
      id: updated.id,
      webhookUrl: updated.webhookUrl,
      settings: updated.settings,
    };
  });
}

// === SSRF Protection ===

function isAllowedWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Block localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return false;
    }

    // Block private IPs
    const privateRanges = [
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^0\./,
    ];

    for (const range of privateRanges) {
      if (range.test(hostname)) {
        return false;
      }
    }

    // Must be HTTPS in production
    if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
