import { Queue } from 'bullmq';
import type { WebhookPayload } from '@wa-gateway/types';

let webhookQueue: Queue | null = null;

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: parseInt(u.port || '6379'), password: u.password || undefined };
}

export function getWebhookQueue(redisUrl: string): Queue {
  if (!webhookQueue) {
    webhookQueue = new Queue('wa-webhook', {
      connection: parseRedisUrl(redisUrl),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return webhookQueue;
}

export async function dispatchWebhook(
  instanceId: string,
  webhookUrl: string,
  payload: WebhookPayload,
  redisUrl: string,
): Promise<void> {
  const queue = getWebhookQueue(redisUrl);
  await queue.add('dispatch', { instanceId, webhookUrl, payload });
}
