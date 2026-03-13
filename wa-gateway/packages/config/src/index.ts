import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  REDIS_PASSWORD: z.string().default(''),

  API_PORT: z.coerce.number().default(3100),
  API_HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  MASTER_API_KEY: z.string().min(16),
  SESSION_ENCRYPTION_KEY: z.string().optional(),

  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USER: z.string().default('minioadmin'),
  MINIO_PASSWORD: z.string().default('minioadmin123'),

  WEBHOOK_TIMEOUT_MS: z.coerce.number().default(10000),
  WEBHOOK_MAX_RETRIES: z.coerce.number().default(3),

  RATE_LIMIT_SEND_PER_MIN: z.coerce.number().default(100),
  RATE_LIMIT_READ_PER_MIN: z.coerce.number().default(1000),

  MIN_DELAY_BETWEEN_MESSAGES_MS: z.coerce.number().default(1000),
});

export type EnvConfig = z.infer<typeof envSchema>;

let _config: EnvConfig | null = null;

export function getConfig(): EnvConfig {
  if (!_config) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error('Invalid environment variables:');
      console.error(result.error.format());
      process.exit(1);
    }
    _config = result.data;
  }
  return _config;
}

export { envSchema };
