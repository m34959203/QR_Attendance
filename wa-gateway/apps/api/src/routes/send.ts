import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Queue } from 'bullmq';
import { getDb } from '@wa-gateway/db';
import { getConfig } from '@wa-gateway/config';
import { ErrorCode } from '@wa-gateway/types';
import type { SendTextBody, SendImageBody, SendDocumentBody, SendAudioBody, SendLocationBody, SendContactBody, SendPollBody, SendReactionBody, SendTypingBody } from '@wa-gateway/types';

const chatIdPattern = '^\\d+@(s\\.whatsapp\\.net|g\\.us)$';

let sendQueue: Queue | null = null;

function getSendQueue(): Queue {
  if (!sendQueue) {
    const config = getConfig();
    const u = new URL(config.REDIS_URL);
    sendQueue = new Queue('wa-send', {
      connection: { host: u.hostname, port: parseInt(u.port || '6379'), password: u.password || undefined },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    });
  }
  return sendQueue;
}

// Schemas
const mkSchema = (required: string[], props: Record<string, any>) => ({
  body: { type: 'object', required, properties: { chatId: { type: 'string', pattern: chatIdPattern }, ...props } },
});

const schemas = {
  text: mkSchema(['chatId', 'message'], { message: { type: 'string', minLength: 1, maxLength: 10000 }, quotedMessageId: { type: 'string' } }),
  image: mkSchema(['chatId', 'image'], { image: { type: 'string' }, caption: { type: 'string', maxLength: 3000 } }),
  document: mkSchema(['chatId', 'document', 'fileName'], { document: { type: 'string' }, fileName: { type: 'string' }, caption: { type: 'string', maxLength: 3000 } }),
  audio: mkSchema(['chatId', 'audio'], { audio: { type: 'string' } }),
  location: mkSchema(['chatId', 'latitude', 'longitude'], { latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, name: { type: 'string' } }),
  contact: mkSchema(['chatId', 'contact'], { contact: { type: 'object', required: ['name', 'phone'], properties: { name: { type: 'string' }, phone: { type: 'string' } } } }),
  poll: mkSchema(['chatId', 'name', 'options'], { name: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 12 }, multipleAnswers: { type: 'boolean' } }),
  reaction: mkSchema(['chatId', 'messageId', 'reaction'], { messageId: { type: 'string' }, reaction: { type: 'string' } }),
  typing: mkSchema(['chatId', 'durationMs'], { durationMs: { type: 'number', minimum: 100, maximum: 30000 } }),
};

export async function sendRoutes(app: FastifyInstance) {

  async function ensureConnected(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    if (!request.isMasterKey && request.params.id !== request.instanceId) {
      reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
      return null;
    }
    const db = getDb();
    const instance = await db.instance.findUnique({ where: { id: request.params.id }, select: { id: true, status: true } });
    if (!instance) { reply.status(404).send({ error: ErrorCode.INSTANCE_NOT_FOUND, message: 'Instance not found', code: 404 }); return null; }
    if (instance.status !== 'CONNECTED') {
      reply.status(409).send({ error: ErrorCode.INSTANCE_NOT_CONNECTED, message: 'Instance not connected. Authorize via QR first.', code: 409 });
      return null;
    }
    return instance;
  }

  async function enqueueMessage(instanceId: string, chatId: string, type: string, content: Record<string, unknown>) {
    const db = getDb();
    const msgId = `MSG_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const message = await db.message.create({
      data: { instanceId, messageId: msgId, direction: 'OUTGOING', chatId, type: type as any, content, status: 'PENDING' },
    });

    // Enqueue to BullMQ
    const queue = getSendQueue();
    const config = getConfig();
    await queue.add('send', {
      instanceId, messageDbId: message.id, chatId, type, content,
    }, {
      delay: config.MIN_DELAY_BETWEEN_MESSAGES_MS, // anti-spam delay
    });

    return {
      idMessage: msgId,
      status: 'pending',
      timestamp: Math.floor(message.timestamp.getTime() / 1000),
    };
  }

  // POST /:id/send/text
  app.post<{ Params: { id: string }; Body: SendTextBody }>('/:id/send/text', { schema: schemas.text }, async (req, reply) => {
    const inst = await ensureConnected(req, reply);
    if (!inst) return;
    return enqueueMessage(inst.id, req.body.chatId, 'TEXT', { text: req.body.message, quotedMessageId: req.body.quotedMessageId });
  });

  // POST /:id/send/image
  app.post<{ Params: { id: string }; Body: SendImageBody }>('/:id/send/image', { schema: schemas.image }, async (req, reply) => {
    const inst = await ensureConnected(req, reply);
    if (!inst) return;
    return enqueueMessage(inst.id, req.body.chatId, 'IMAGE', { image: req.body.image, caption: req.body.caption });
  });

  // POST /:id/send/document
  app.post<{ Params: { id: string }; Body: SendDocumentBody }>('/:id/send/document', { schema: schemas.document }, async (req, reply) => {
    const inst = await ensureConnected(req, reply);
    if (!inst) return;
    return enqueueMessage(inst.id, req.body.chatId, 'DOCUMENT', { document: req.body.document, fileName: req.body.fileName, caption: req.body.caption });
  });

  // POST /:id/send/audio
  app.post<{ Params: { id: string }; Body: SendAudioBody }>('/:id/send/audio', { schema: schemas.audio }, async (req, reply) => {
    const inst = await ensureConnected(req, reply);
    if (!inst) return;
    return enqueueMessage(inst.id, req.body.chatId, 'AUDIO', { audio: req.body.audio });
  });

  // POST /:id/send/location
  app.post<{ Params: { id: string }; Body: SendLocationBody }>('/:id/send/location', { schema: schemas.location }, async (req, reply) => {
    const inst = await ensureConnected(req, reply);
    if (!inst) return;
    return enqueueMessage(inst.id, req.body.chatId, 'LOCATION', { latitude: req.body.latitude, longitude: req.body.longitude, name: req.body.name });
  });

  // POST /:id/send/contact
  app.post<{ Params: { id: string }; Body: SendContactBody }>('/:id/send/contact', { schema: schemas.contact }, async (req, reply) => {
    const inst = await ensureConnected(req, reply);
    if (!inst) return;
    return enqueueMessage(inst.id, req.body.chatId, 'CONTACT', { contact: req.body.contact });
  });

  // POST /:id/send/poll
  app.post<{ Params: { id: string }; Body: SendPollBody }>('/:id/send/poll', { schema: schemas.poll }, async (req, reply) => {
    const inst = await ensureConnected(req, reply);
    if (!inst) return;
    return enqueueMessage(inst.id, req.body.chatId, 'POLL', { name: req.body.name, options: req.body.options, multipleAnswers: req.body.multipleAnswers });
  });

  // POST /:id/send/reaction
  app.post<{ Params: { id: string }; Body: SendReactionBody }>('/:id/send/reaction', { schema: schemas.reaction }, async (req, reply) => {
    const inst = await ensureConnected(req, reply);
    if (!inst) return;
    return enqueueMessage(inst.id, req.body.chatId, 'REACTION', { messageId: req.body.messageId, reaction: req.body.reaction });
  });

  // POST /:id/send/typing
  app.post<{ Params: { id: string }; Body: SendTypingBody }>('/:id/send/typing', { schema: schemas.typing }, async (req, reply) => {
    if (!req.isMasterKey && req.params.id !== req.instanceId) {
      return reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
    }
    // Signal worker via Redis pub/sub
    await app.redis.publish('instance:commands', JSON.stringify({
      action: 'send_typing', instanceId: req.params.id, chatId: req.body.chatId, durationMs: req.body.durationMs,
    }));
    return { success: true, chatId: req.body.chatId, durationMs: req.body.durationMs };
  });
}
