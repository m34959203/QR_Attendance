import { getConfig } from '@wa-gateway/config';
import { getDb, disconnectDb } from '@wa-gateway/db';
import { SessionManager } from './baileys/session-manager';
import { createSendWorker } from './queue/send-worker';
import { createWebhookWorker } from './queue/webhook-worker';
import { startNotificationCleanup } from './cleanup';
import { startMetricsServer } from './metrics';
import pino from 'pino';

const logger = pino({ name: 'wa-worker' });

async function main() {
  const config = getConfig();
  const db = getDb();

  logger.info('Starting WA Gateway Worker...');

  // Initialize session manager with Redis for pub/sub
  const sessionManager = new SessionManager(db, logger, config.REDIS_URL);

  // Restore existing sessions (< 30s recovery target)
  await sessionManager.restoreAll();

  // Start BullMQ workers
  const sendWorker = createSendWorker(sessionManager, config, logger);
  const webhookWorker = createWebhookWorker(config, logger);

  // Notification TTL cleanup (every 15 min)
  const cleanupInterval = startNotificationCleanup(db, logger);

  // Prometheus metrics endpoint
  const metricsServer = startMetricsServer(sessionManager, config, logger);

  logger.info('Worker started successfully');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    clearInterval(cleanupInterval);
    metricsServer.close();
    await sendWorker.close();
    await webhookWorker.close();
    await sessionManager.disconnectAll();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start worker');
  process.exit(1);
});
