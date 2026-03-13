import Fastify from 'fastify';
import cors from '@fastify/cors';
import { getConfig } from '@wa-gateway/config';
import { getDb, disconnectDb } from '@wa-gateway/db';
import { authPlugin } from './middleware/auth';
import { instanceRoutes } from './routes/instances';
import { sendRoutes } from './routes/send';
import { notificationRoutes } from './routes/notifications';

async function main() {
  const config = getConfig();

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'development' ? 'debug' : 'info',
      transport: config.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });

  // CORS
  await app.register(cors, { origin: true });

  // Health check — public
  app.get('/health', async () => {
    const db = getDb();
    try {
      await db.$queryRaw`SELECT 1`;
      return { status: 'ok', timestamp: new Date().toISOString(), db: 'connected' };
    } catch {
      return { status: 'degraded', timestamp: new Date().toISOString(), db: 'disconnected' };
    }
  });

  // Auth plugin for /v1 routes
  await app.register(async (v1) => {
    await v1.register(authPlugin);
    await v1.register(instanceRoutes, { prefix: '/instances' });
    await v1.register(sendRoutes, { prefix: '/instances' });
    await v1.register(notificationRoutes, { prefix: '/instances' });
  }, { prefix: '/v1' });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down...`);
    await app.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start
  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  app.log.info(`WA Gateway API running on ${config.API_HOST}:${config.API_PORT}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
