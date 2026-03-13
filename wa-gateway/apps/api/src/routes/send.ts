import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '@wa-gateway/db';
import { ErrorCode, isValidChatId } from '@wa-gateway/types';
import type {
  SendTextBody,
  SendImageBody,
  SendDocumentBody,
  SendAudioBody,
  SendLocationBody,
  SendContactBody,
  SendPollBody,
  SendReactionBody,
  SendTypingBody,
} from '@wa-gateway/types';

const chatIdPattern = '^\\d+@(s\\.whatsapp\\.net|g\\.us)$';

const sendTextSchema = {
  body: {
    type: 'object',
    required: ['chatId', 'message'],
    properties: {
      chatId: { type: 'string', pattern: chatIdPattern },
      message: { type: 'string', minLength: 1, maxLength: 10000 },
      quotedMessageId: { type: 'string' },
    },
  },
};

const sendImageSchema = {
  body: {
    type: 'object',
    required: ['chatId', 'image'],
    properties: {
      chatId: { type: 'string', pattern: chatIdPattern },
      image: { type: 'string' },
      caption: { type: 'string', maxLength: 3000 },
    },
  },
};

const sendDocumentSchema = {
  body: {
    type: 'object',
    required: ['chatId', 'document', 'fileName'],
    properties: {
      chatId: { type: 'string', pattern: chatIdPattern },
      document: { type: 'string' },
      fileName: { type: 'string' },
      caption: { type: 'string', maxLength: 3000 },
    },
  },
};

const sendAudioSchema = {
  body: {
    type: 'object',
    required: ['chatId', 'audio'],
    properties: {
      chatId: { type: 'string', pattern: chatIdPattern },
      audio: { type: 'string' },
    },
  },
};

const sendLocationSchema = {
  body: {
    type: 'object',
    required: ['chatId', 'latitude', 'longitude'],
    properties: {
      chatId: { type: 'string', pattern: chatIdPattern },
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
      name: { type: 'string' },
    },
  },
};

const sendContactSchema = {
  body: {
    type: 'object',
    required: ['chatId', 'contact'],
    properties: {
      chatId: { type: 'string', pattern: chatIdPattern },
      contact: {
        type: 'object',
        required: ['name', 'phone'],
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
        },
      },
    },
  },
};

const sendPollSchema = {
  body: {
    type: 'object',
    required: ['chatId', 'name', 'options'],
    properties: {
      chatId: { type: 'string', pattern: chatIdPattern },
      name: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 12 },
      multipleAnswers: { type: 'boolean' },
    },
  },
};

const sendReactionSchema = {
  body: {
    type: 'object',
    required: ['chatId', 'messageId', 'reaction'],
    properties: {
      chatId: { type: 'string', pattern: chatIdPattern },
      messageId: { type: 'string' },
      reaction: { type: 'string' },
    },
  },
};

const sendTypingSchema = {
  body: {
    type: 'object',
    required: ['chatId', 'durationMs'],
    properties: {
      chatId: { type: 'string', pattern: chatIdPattern },
      durationMs: { type: 'number', minimum: 100, maximum: 30000 },
    },
  },
};

export async function sendRoutes(app: FastifyInstance) {

  // Helper: check instance is connected
  async function ensureConnected(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    if (request.params.id !== request.instanceId) {
      reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
      return null;
    }

    const db = getDb();
    const instance = await db.instance.findUnique({
      where: { id: request.params.id },
      select: { id: true, status: true },
    });

    if (!instance) {
      reply.status(404).send({ error: ErrorCode.INSTANCE_NOT_FOUND, message: 'Instance not found', code: 404 });
      return null;
    }

    if (instance.status !== 'CONNECTED') {
      reply.status(409).send({
        error: ErrorCode.INSTANCE_NOT_CONNECTED,
        message: 'Instance not connected. Authorize via QR first.',
        code: 409,
      });
      return null;
    }

    return instance;
  }

  // Helper: create message record and return standard response
  async function createOutgoingMessage(
    instanceId: string,
    chatId: string,
    type: string,
    content: Record<string, unknown>,
    ip: string,
  ) {
    const db = getDb();
    const msgId = `MSG_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const message = await db.message.create({
      data: {
        instanceId,
        messageId: msgId,
        direction: 'OUTGOING',
        chatId,
        type: type as any,
        content,
        status: 'PENDING',
      },
    });

    // TODO: enqueue to BullMQ for actual sending via Worker

    return {
      idMessage: msgId,
      status: 'pending',
      timestamp: Math.floor(message.timestamp.getTime() / 1000),
    };
  }

  // POST /:id/send/text
  app.post<{ Params: { id: string }; Body: SendTextBody }>('/:id/send/text', {
    schema: sendTextSchema,
  }, async (request, reply) => {
    const instance = await ensureConnected(request, reply);
    if (!instance) return;

    return createOutgoingMessage(instance.id, request.body.chatId, 'TEXT', {
      text: request.body.message,
      quotedMessageId: request.body.quotedMessageId,
    }, request.ip);
  });

  // POST /:id/send/image
  app.post<{ Params: { id: string }; Body: SendImageBody }>('/:id/send/image', {
    schema: sendImageSchema,
  }, async (request, reply) => {
    const instance = await ensureConnected(request, reply);
    if (!instance) return;

    return createOutgoingMessage(instance.id, request.body.chatId, 'IMAGE', {
      image: request.body.image,
      caption: request.body.caption,
    }, request.ip);
  });

  // POST /:id/send/document
  app.post<{ Params: { id: string }; Body: SendDocumentBody }>('/:id/send/document', {
    schema: sendDocumentSchema,
  }, async (request, reply) => {
    const instance = await ensureConnected(request, reply);
    if (!instance) return;

    return createOutgoingMessage(instance.id, request.body.chatId, 'DOCUMENT', {
      document: request.body.document,
      fileName: request.body.fileName,
      caption: request.body.caption,
    }, request.ip);
  });

  // POST /:id/send/audio
  app.post<{ Params: { id: string }; Body: SendAudioBody }>('/:id/send/audio', {
    schema: sendAudioSchema,
  }, async (request, reply) => {
    const instance = await ensureConnected(request, reply);
    if (!instance) return;

    return createOutgoingMessage(instance.id, request.body.chatId, 'AUDIO', {
      audio: request.body.audio,
    }, request.ip);
  });

  // POST /:id/send/location
  app.post<{ Params: { id: string }; Body: SendLocationBody }>('/:id/send/location', {
    schema: sendLocationSchema,
  }, async (request, reply) => {
    const instance = await ensureConnected(request, reply);
    if (!instance) return;

    return createOutgoingMessage(instance.id, request.body.chatId, 'LOCATION', {
      latitude: request.body.latitude,
      longitude: request.body.longitude,
      name: request.body.name,
    }, request.ip);
  });

  // POST /:id/send/contact
  app.post<{ Params: { id: string }; Body: SendContactBody }>('/:id/send/contact', {
    schema: sendContactSchema,
  }, async (request, reply) => {
    const instance = await ensureConnected(request, reply);
    if (!instance) return;

    return createOutgoingMessage(instance.id, request.body.chatId, 'CONTACT', {
      contact: request.body.contact,
    }, request.ip);
  });

  // POST /:id/send/poll
  app.post<{ Params: { id: string }; Body: SendPollBody }>('/:id/send/poll', {
    schema: sendPollSchema,
  }, async (request, reply) => {
    const instance = await ensureConnected(request, reply);
    if (!instance) return;

    return createOutgoingMessage(instance.id, request.body.chatId, 'POLL', {
      name: request.body.name,
      options: request.body.options,
      multipleAnswers: request.body.multipleAnswers,
    }, request.ip);
  });

  // POST /:id/send/reaction
  app.post<{ Params: { id: string }; Body: SendReactionBody }>('/:id/send/reaction', {
    schema: sendReactionSchema,
  }, async (request, reply) => {
    const instance = await ensureConnected(request, reply);
    if (!instance) return;

    return createOutgoingMessage(instance.id, request.body.chatId, 'REACTION', {
      messageId: request.body.messageId,
      reaction: request.body.reaction,
    }, request.ip);
  });

  // POST /:id/send/typing
  app.post<{ Params: { id: string }; Body: SendTypingBody }>('/:id/send/typing', {
    schema: sendTypingSchema,
  }, async (request, reply) => {
    if (request.params.id !== request.instanceId) {
      return reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
    }

    // TODO: signal worker to send typing indicator via Baileys
    return { success: true, chatId: request.body.chatId, durationMs: request.body.durationMs };
  });
}
