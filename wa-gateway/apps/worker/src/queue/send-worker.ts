import { Worker, Job } from 'bullmq';
import { SessionManager } from '../baileys/session-manager';
import { getDb } from '@wa-gateway/db';
import type { EnvConfig } from '@wa-gateway/config';

interface SendJob {
  instanceId: string;
  messageId: string;
  chatId: string;
  type: string;
  content: Record<string, unknown>;
}

export function createSendWorker(sessionManager: SessionManager, config: EnvConfig): Worker {
  const worker = new Worker<SendJob>(
    'wa-send',
    async (job: Job<SendJob>) => {
      const { instanceId, messageId, chatId, type, content } = job.data;
      const db = getDb();

      const session = sessionManager.getSession(instanceId);
      if (!session) {
        throw new Error(`No active session for instance ${instanceId}`);
      }

      let waMessageId: string;

      switch (type) {
        case 'TEXT':
          waMessageId = await session.sendText(chatId, content.text as string, content.quotedMessageId as string | undefined);
          break;
        case 'IMAGE':
          waMessageId = await session.sendImage(chatId, content.image as string, content.caption as string | undefined);
          break;
        case 'DOCUMENT':
          waMessageId = await session.sendDocument(chatId, content.document as string, content.fileName as string, content.caption as string | undefined);
          break;
        default:
          throw new Error(`Unsupported message type: ${type}`);
      }

      // Update message status
      await db.message.update({
        where: { id: messageId },
        data: { status: 'SENT', messageId: waMessageId },
      });

      return { waMessageId };
    },
    {
      connection: {
        host: new URL(config.REDIS_URL).hostname,
        port: parseInt(new URL(config.REDIS_URL).port || '6379'),
        password: config.REDIS_PASSWORD || undefined,
      },
      concurrency: 5,
      limiter: {
        max: config.RATE_LIMIT_SEND_PER_MIN,
        duration: 60000,
      },
    },
  );

  worker.on('completed', (job) => {
    console.log(`Send job ${job.id} completed`);
  });

  worker.on('failed', async (job, err) => {
    console.error(`Send job ${job?.id} failed:`, err.message);

    if (job) {
      const db = getDb();
      await db.message.update({
        where: { id: job.data.messageId },
        data: { status: 'FAILED' },
      }).catch(() => {});
    }
  });

  return worker;
}
