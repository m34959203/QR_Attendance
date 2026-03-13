import { Worker, Job } from 'bullmq';
import type { EnvConfig } from '@wa-gateway/config';

interface WebhookJob {
  instanceId: string;
  webhookUrl: string;
  payload: Record<string, unknown>;
  attempt?: number;
}

export function createWebhookWorker(config: EnvConfig): Worker {
  const worker = new Worker<WebhookJob>(
    'wa-webhook',
    async (job: Job<WebhookJob>) => {
      const { webhookUrl, payload } = job.data;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.WEBHOOK_TIMEOUT_MS);

      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
        }

        return { status: response.status };
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      connection: {
        host: new URL(config.REDIS_URL).hostname,
        port: parseInt(new URL(config.REDIS_URL).port || '6379'),
        password: config.REDIS_PASSWORD || undefined,
      },
      concurrency: 10,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`Webhook job ${job?.id} failed:`, err.message);
  });

  return worker;
}
