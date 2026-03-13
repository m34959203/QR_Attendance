import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import * as bcrypt from 'bcrypt';
import { getDb } from '@wa-gateway/db';
import { ErrorCode } from '@wa-gateway/types';

declare module 'fastify' {
  interface FastifyRequest {
    instanceId?: string;
    apiKeyRaw?: string;
  }
}

async function authPluginImpl(app: FastifyInstance) {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = request.headers['x-api-key'] as string | undefined;

    if (!apiKey) {
      return reply.status(401).send({
        error: ErrorCode.UNAUTHORIZED,
        message: 'Missing X-API-Key header',
        code: 401,
      });
    }

    const db = getDb();

    // Find instance by API key
    // For MVP: we store API keys as plain text for simplicity
    // TODO: migrate to bcrypt hashes in production
    const instance = await db.instance.findUnique({
      where: { apiKey },
      select: { id: true, apiKey: true },
    });

    if (!instance) {
      return reply.status(401).send({
        error: ErrorCode.UNAUTHORIZED,
        message: 'Invalid API key',
        code: 401,
      });
    }

    request.instanceId = instance.id;
    request.apiKeyRaw = apiKey;
  });
}

export const authPlugin = fp(authPluginImpl, {
  name: 'auth-plugin',
});
