import { Worker, Job } from 'bullmq';
import type { EnvConfig } from '@wa-gateway/config';
import type { Logger } from 'pino';

interface WebhookJob {
  instanceId: string;
  webhookUrl: string;
  payload: Record<string, unknown>;
}

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: parseInt(u.port || '6379'), password: u.password || undefined };
}

export function createWebhookWorker(config: EnvConfig, logger: Logger): Worker {
  const connection = parseRedisUrl(config.REDIS_URL);

  const worker = new Worker<WebhookJob>(
    'wa-webhook',
    async (job: Job<WebhookJob>) => {
      const { webhookUrl, payload } = job.data;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.WEBHOOK_TIMEOUT_MS);

      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'WA-Gateway/1.0',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Webhook ${response.status}: ${response.statusText}`);
        }

        logger.debug({ jobId: job.id, status: response.status }, 'Webhook delivered');
        return { status: response.status };
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      connection,
      concurrency: 10,
      defaultJobOptions: {
        attempts: config.WEBHOOK_MAX_RETRIES,
        backoff: {
          type: 'exponential',
          delay: 2000,  // 2s → 4s → 8s
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'Webhook delivery failed');
  });

  return worker;
}
