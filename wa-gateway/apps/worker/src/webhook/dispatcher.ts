import { Queue } from 'bullmq';
import { getDb } from '@wa-gateway/db';
import type { WebhookPayload } from '@wa-gateway/types';

let webhookQueue: Queue | null = null;

export function getWebhookQueue(redisUrl: string, redisPassword?: string): Queue {
  if (!webhookQueue) {
    const url = new URL(redisUrl);
    webhookQueue = new Queue('wa-webhook', {
      connection: {
        host: url.hostname,
        port: parseInt(url.port || '6379'),
        password: redisPassword || undefined,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return webhookQueue;
}

export async function dispatchWebhook(
  instanceId: string,
  payload: WebhookPayload,
  redisUrl: string,
  redisPassword?: string,
): Promise<void> {
  const db = getDb();
  const instance = await db.instance.findUnique({
    where: { id: instanceId },
    select: { webhookUrl: true },
  });

  if (!instance?.webhookUrl) return;

  const queue = getWebhookQueue(redisUrl, redisPassword);
  await queue.add('dispatch', {
    instanceId,
    webhookUrl: instance.webhookUrl,
    payload,
  });
}
