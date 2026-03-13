import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { getDb } from '@wa-gateway/db';
import { getConfig } from '@wa-gateway/config';
import { ErrorCode } from '@wa-gateway/types';

declare module 'fastify' {
  interface FastifyRequest {
    instanceId?: string;
    apiKeyRaw?: string;
    isMasterKey?: boolean;
  }
  interface FastifyInstance {
    redis: import('ioredis').Redis;
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

    const config = getConfig();

    // Master API key can create instances (no instance lookup needed for POST /instances)
    if (apiKey === config.MASTER_API_KEY) {
      request.isMasterKey = true;
      request.apiKeyRaw = apiKey;
      return;
    }

    // Instance-specific API key
    const db = getDb();
    const instance = await db.instance.findUnique({
      where: { apiKey },
      select: { id: true },
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

export const authPlugin = fp(authPluginImpl, { name: 'auth-plugin' });
