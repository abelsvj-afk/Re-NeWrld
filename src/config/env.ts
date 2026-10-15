import { z } from 'zod';

export const envSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  // Rate limiting (requests per window, per IP). Skipped entirely when APP_ENV=test.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  // Tighter limit for the auth endpoints (login/register are brute-force targets).
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  // Strictest limit: the password-reset endpoints are account-takeover and
  // spam targets (FR-13, ADR-012).
  RATE_LIMIT_RESET_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_RESET_WINDOW_MS: z.coerce.number().int().positive().default(3600000),
  // Outbound email for account recovery. 'console' logs the reset link
  // (dev/test default); 'resend' sends via the Resend API (free tier).
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().default('Re:NeWrld <noreply@example.com>'),
  // ElevenLabs TTS for scene narration (ADR-016). Unset = narration disabled.
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  NARRATION_STORAGE_PATH: z.string().default('/data/narrations'),
  NARRATION_MONTHLY_CHAR_CAP: z.coerce.number().int().positive().default(40000),
  // Public base URL used to build the reset link emailed to users.
  APP_BASE_URL: z.string().url().default('http://localhost:8080'),
  // Browser frontend origin for CORS. Unset = no CORS headers (same-origin/API-only).
  CORS_ORIGIN: z.string().url().optional(),
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

/**
 * Cross-field rule: the Resend adapter cannot send without an API key.
 * Kept out of the error message's raw values (validateEnv never leaks input).
 */
const envSchemaWithEmailCheck = envSchema.superRefine((val, ctx) => {
  if (val.EMAIL_PROVIDER === 'resend' && !val.RESEND_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RESEND_API_KEY'],
      message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend',
    });
  }
});

export function validateEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchemaWithEmailCheck.safeParse(input);

  if (!result.success) {
    const invalidFields = Array.from(new Set(result.error.issues.map((issue) => issue.path.join('.')))).join(', ');
    const errorMsg = `Invalid environment variables configuration for fields: [${invalidFields}]`;
    console.error('❌ Invalid environment variables configuration:', errorMsg);
    throw new Error(errorMsg);
  }

  return result.data;
}

export const env = validateEnv();
