import { PrismaClient } from '@wa-gateway/db';
import type { Logger } from 'pino';

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function startNotificationCleanup(db: PrismaClient, logger: Logger): NodeJS.Timeout {
  const cleanup = async () => {
    try {
      const result = await db.notification.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (result.count > 0) {
        logger.info({ deleted: result.count }, 'Expired notifications cleaned up');
      }
    } catch (err) {
      logger.error({ err }, 'Notification cleanup failed');
    }
  };

  // Run immediately on start
  cleanup();

  return setInterval(cleanup, CLEANUP_INTERVAL_MS);
}
