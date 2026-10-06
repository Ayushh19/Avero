import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const envSchema = z
  .object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  API_ORIGIN: z.url().default('http://localhost:3000'),
  /** Omit (or set to "memory") for an in-memory database. */
  DATABASE_DIR: z.string().default('./.data/pglite'),
  /** Rehosted catalog imagery, served at /media. */
  MEDIA_DIR: z.string().default('./.data/media'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),
  SIMULATION_TOOLS: bool,
  TIME_SCALE: z.coerce.number().positive().default(60),
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  /**
   * Where Google sends the browser back to — registered verbatim in the Google Cloud console.
   * Any path on the API works (e.g. `http://localhost:3000`): the callback is served at it.
   */
  GOOGLE_REDIRECT_URI: optionalString,
  SMTP_URL: optionalString,
  MAIL_FROM: z.string().default('AVERO <no-reply@avero.local>'),
  SKU_API_URL: optionalString,
})
  .superRefine((env, issue) => {
    if (!env.GOOGLE_REDIRECT_URI) return;
    let redirect: URL;
    try {
      redirect = new URL(env.GOOGLE_REDIRECT_URI);
    } catch {
      issue.addIssue({ code: 'custom', path: ['GOOGLE_REDIRECT_URI'], message: 'must be a full URL, e.g. http://localhost:3000' });
      return;
    }
    // Google returns the browser here with the code; only this API can finish the sign-in.
    if (redirect.origin !== new URL(env.API_ORIGIN).origin) {
      issue.addIssue({
        code: 'custom',
        path: ['GOOGLE_REDIRECT_URI'],
        message: `must point at the API (${new URL(env.API_ORIGIN).origin}), not ${redirect.origin}`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

/** Path the Google callback is served at, taken from GOOGLE_REDIRECT_URI. */
export function googleCallbackPath(env: Env): string | null {
  return env.GOOGLE_REDIRECT_URI ? new URL(env.GOOGLE_REDIRECT_URI).pathname : null;
}

export function googleEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);
}
