import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Redis } from 'ioredis';
import { getConfig } from '@wa-gateway/config';
import { getDb, disconnectDb } from '@wa-gateway/db';
import { authPlugin } from './middleware/auth';
import { securityHeaders } from './middleware/security';
import { instanceRoutes } from './routes/instances';
import { sendRoutes } from './routes/send';
import { notificationRoutes } from './routes/notifications';
import { chatRoutes } from './routes/chats';
import { metricsRoute } from './routes/metrics';

async function main() {
  const config = getConfig();
  const redis = new Redis(config.REDIS_URL);

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'development' ? 'debug' : 'info',
      transport: config.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
    trustProxy: true,
  });

  // Store redis on app for route access
  app.decorate('redis', redis);

  // CORS
  await app.register(cors, { origin: true });

  // Security headers
  await app.register(securityHeaders);

  // Rate limiting (Redis-backed sliding window)
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_READ_PER_MIN,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (request) => {
      return request.headers['x-api-key'] as string || request.ip;
    },
  });

  // Swagger / OpenAPI
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'WA Gateway API',
        description: 'WhatsApp API Gateway built on Baileys',
        version: '1.0.0',
      },
      servers: [{ url: '/v1', description: 'API v1' }],
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
        },
      },
      security: [{ apiKey: [] }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // Health check — public
  app.get('/health', async () => {
    const db = getDb();
    let dbOk = false;
    try { await db.$queryRaw`SELECT 1`; dbOk = true; } catch { /* */ }
    let redisOk = false;
    try { await redis.ping(); redisOk = true; } catch { /* */ }
    const status = dbOk && redisOk ? 'ok' : 'degraded';
    return { status, timestamp: new Date().toISOString(), db: dbOk ? 'connected' : 'disconnected', redis: redisOk ? 'connected' : 'disconnected' };
  });

  // Metrics — public (Prometheus)
  await app.register(metricsRoute);

  // Auth-protected /v1 routes
  await app.register(async (v1) => {
    await v1.register(authPlugin);
    await v1.register(instanceRoutes, { prefix: '/instances' });
    await v1.register(sendRoutes, { prefix: '/instances' });
    await v1.register(notificationRoutes, { prefix: '/instances' });
    await v1.register(chatRoutes, { prefix: '/instances' });
  }, { prefix: '/v1' });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down...`);
    await app.close();
    redis.disconnect();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  app.log.info(`WA Gateway API running on ${config.API_HOST}:${config.API_PORT}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
