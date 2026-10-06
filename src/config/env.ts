import { z } from 'zod';

export const envSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(input: Record<string, unknown> = process.env): Env {
  const result = envSchema.safeParse(input);

  if (!result.success) {
    const errorSummary = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || 'config';
      // Sanitize error message to prevent leaking supplied raw values / potential secrets
      const msg = issue.message.replace(/, received [^)]+$/, '');
      return `${path}: ${msg}`;
    });
    const errorDetails = JSON.stringify(errorSummary, null, 2);
    console.error('❌ Invalid environment variables configuration:', errorDetails);
    throw new Error(`Invalid environment variables configuration: ${errorDetails}`);
  }

  return result.data;
}

export const env = validateEnv();
