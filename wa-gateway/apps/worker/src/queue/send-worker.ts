import { Worker, Job } from 'bullmq';
import { SessionManager } from '../baileys/session-manager';
import { getDb } from '@wa-gateway/db';
import type { EnvConfig } from '@wa-gateway/config';
import type { Logger } from 'pino';

interface SendJob {
  instanceId: string;
  messageDbId: string;
  chatId: string;
  type: string;
  content: Record<string, unknown>;
}

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || '6379'),
    password: u.password || undefined,
  };
}

export function createSendWorker(sessionManager: SessionManager, config: EnvConfig, logger: Logger): Worker {
  const connection = parseRedisUrl(config.REDIS_URL);

  const worker = new Worker<SendJob>(
    'wa-send',
    async (job: Job<SendJob>) => {
      const { instanceId, messageDbId, chatId, type, content } = job.data;
      const db = getDb();

      const session = sessionManager.getSession(instanceId);
      if (!session) throw new Error(`No active session for instance ${instanceId}`);

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
        case 'AUDIO':
          waMessageId = await session.sendAudio(chatId, content.audio as string);
          break;
        case 'LOCATION':
          waMessageId = await session.sendLocation(chatId, content.latitude as number, content.longitude as number, content.name as string | undefined);
          break;
        case 'CONTACT':
          waMessageId = await session.sendContact(chatId, content.contact as { name: string; phone: string });
          break;
        case 'POLL':
          waMessageId = await session.sendPoll(chatId, content.name as string, content.options as string[], content.multipleAnswers as boolean | undefined);
          break;
        case 'REACTION':
          waMessageId = await session.sendReaction(chatId, content.messageId as string, content.reaction as string);
          break;
        default:
          throw new Error(`Unsupported message type: ${type}`);
      }

      // Update message status in DB
      await db.message.update({
        where: { id: messageDbId },
        data: { status: 'SENT', messageId: waMessageId },
      });

      // Audit log
      await db.auditLog.create({
        data: { instanceId, action: 'send_message', details: { type, chatId, waMessageId } },
      });

      return { waMessageId };
    },
    {
      connection,
      concurrency: 5,
      limiter: {
        max: config.RATE_LIMIT_SEND_PER_MIN,
        duration: 60000,
      },
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Send job completed');
  });

  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Send job failed');
    if (job) {
      const db = getDb();
      await db.message.update({
        where: { id: job.data.messageDbId },
        data: { status: 'FAILED' },
      }).catch(() => {});
    }
  });

  return worker;
}
