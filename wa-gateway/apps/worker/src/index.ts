import { getConfig } from '@wa-gateway/config';
import { getDb, disconnectDb } from '@wa-gateway/db';
import { SessionManager } from './baileys/session-manager';
import { createSendWorker } from './queue/send-worker';
import { createWebhookWorker } from './queue/webhook-worker';
import pino from 'pino';

const logger = pino({ name: 'wa-worker' });

async function main() {
  const config = getConfig();
  const db = getDb();

  logger.info('Starting WA Gateway Worker...');

  // Initialize session manager
  const sessionManager = new SessionManager(db, logger);

  // Restore existing sessions
  await sessionManager.restoreAll();

  // Start BullMQ workers
  const sendWorker = createSendWorker(sessionManager, config);
  const webhookWorker = createWebhookWorker(config);

  logger.info('Worker started successfully');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
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
