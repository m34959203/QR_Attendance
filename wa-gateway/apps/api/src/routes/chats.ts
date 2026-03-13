import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '@wa-gateway/db';
import { ErrorCode } from '@wa-gateway/types';

export async function chatRoutes(app: FastifyInstance) {

  function checkAccess(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): boolean {
    if (!request.isMasterKey && request.params.id !== request.instanceId) {
      reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
      return false;
    }
    return true;
  }

  // GET /:id/chats
  app.get<{ Params: { id: string } }>('/:id/chats', async (request, reply) => {
    if (!checkAccess(request, reply)) return;
    const db = getDb();
    const messages = await db.message.findMany({
      where: { instanceId: request.params.id },
      orderBy: { timestamp: 'desc' },
      distinct: ['chatId'],
      take: 50,
      select: { chatId: true, timestamp: true, content: true, direction: true },
    });
    return messages.map((m) => ({
      chatId: m.chatId, lastMessageTime: m.timestamp, lastMessage: m.content, direction: m.direction,
    }));
  });

  // GET /:id/chats/:chatId/history
  app.get<{ Params: { id: string; chatId: string }; Querystring: { limit?: string; offset?: string } }>(
    '/:id/chats/:chatId/history', async (request, reply) => {
      if (!checkAccess(request, reply)) return;
      const db = getDb();
      const limit = Math.min(parseInt(request.query.limit || '50'), 200);
      const offset = parseInt(request.query.offset || '0');
      return db.message.findMany({
        where: { instanceId: request.params.id, chatId: request.params.chatId },
        orderBy: { timestamp: 'desc' },
        take: limit, skip: offset,
      });
    },
  );

  // GET /:id/contacts
  app.get<{ Params: { id: string } }>('/:id/contacts', async (request, reply) => {
    if (!checkAccess(request, reply)) return;
    const db = getDb();
    // Derive contacts from message history
    const contacts = await db.message.findMany({
      where: { instanceId: request.params.id, chatId: { endsWith: '@s.whatsapp.net' } },
      orderBy: { timestamp: 'desc' },
      distinct: ['chatId'],
      take: 100,
      select: { chatId: true, timestamp: true },
    });
    return contacts.map((c) => ({ chatId: c.chatId, lastSeen: c.timestamp }));
  });

  // GET /:id/contacts/:chatId
  app.get<{ Params: { id: string; chatId: string } }>('/:id/contacts/:chatId', async (request, reply) => {
    if (!checkAccess(request, reply)) return;
    // Basic info from DB; full info requires worker (profile pic, status)
    const db = getDb();
    const lastMsg = await db.message.findFirst({
      where: { instanceId: request.params.id, chatId: request.params.chatId },
      orderBy: { timestamp: 'desc' },
    });
    return { chatId: request.params.chatId, lastMessage: lastMsg };
  });

  // POST /:id/contacts/check
  app.post<{ Params: { id: string }; Body: { phoneNumber: string } }>(
    '/:id/contacts/check',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phoneNumber'],
          properties: { phoneNumber: { type: 'string', pattern: '^\\d{10,15}$' } },
        },
      },
    },
    async (request, reply) => {
      if (!checkAccess(request, reply)) return;
      // This requires worker — publish command and return async
      // For MVP, return basic response; real check via worker WebSocket
      return { phoneNumber: request.body.phoneNumber, message: 'Number check requires active session. Use worker API.' };
    },
  );

  // GET /:id/groups
  app.get<{ Params: { id: string } }>('/:id/groups', async (request, reply) => {
    if (!checkAccess(request, reply)) return;
    const db = getDb();
    const groups = await db.message.findMany({
      where: { instanceId: request.params.id, chatId: { endsWith: '@g.us' } },
      orderBy: { timestamp: 'desc' },
      distinct: ['chatId'],
      take: 50,
      select: { chatId: true, timestamp: true },
    });
    return groups.map((g) => ({ groupId: g.chatId, lastActivity: g.timestamp }));
  });

  // POST /:id/groups
  app.post<{ Params: { id: string }; Body: { name: string; participants: string[] } }>(
    '/:id/groups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'participants'],
          properties: {
            name: { type: 'string', minLength: 1 },
            participants: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!checkAccess(request, reply)) return;
      return { message: 'Group creation requires active session. Use worker API.' };
    },
  );

  // GET /:id/messages (query messages)
  app.get<{ Params: { id: string }; Querystring: { chatId?: string; from?: string; to?: string; limit?: string } }>(
    '/:id/messages', async (request, reply) => {
      if (!checkAccess(request, reply)) return;
      const db = getDb();
      const where: any = { instanceId: request.params.id };
      if (request.query.chatId) where.chatId = request.query.chatId;
      if (request.query.from || request.query.to) {
        where.timestamp = {};
        if (request.query.from) where.timestamp.gte = new Date(request.query.from);
        if (request.query.to) where.timestamp.lte = new Date(request.query.to);
      }
      const limit = Math.min(parseInt(request.query.limit || '100'), 500);
      return db.message.findMany({ where, orderBy: { timestamp: 'desc' }, take: limit });
    },
  );
}
