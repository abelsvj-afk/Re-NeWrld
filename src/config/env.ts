import { z } from 'zod';

export const envSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().refine(
    (val) => {
      try {
        const parsed = new URL(val);
        if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
          return false;
        }
        if (!parsed.hostname || parsed.hostname.length === 0) {
          return false;
        }
        if (parsed.port) {
          const portNum = Number(parsed.port);
          if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
            return false;
          }
        }
        return true;
      } catch {
        return false;
      }
    },
    { message: 'DATABASE_URL must be a valid PostgreSQL URL with postgresql:// or postgres:// scheme, a valid host, and optional valid port (1-65535)' }
  ),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(input);

  if (!result.success) {
    const invalidFields = Array.from(new Set(result.error.issues.map((issue) => issue.path.join('.')))).join(', ');
    const errorMsg = `Invalid environment variables configuration for fields: [${invalidFields}]`;
    console.error('❌ Invalid environment variables configuration:', errorMsg);
    throw new Error(errorMsg);
  }

  return result.data;
}

export const env = validateEnv();
