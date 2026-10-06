import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { openDatabase } from '../src/db/client';

export const testEnv = loadEnv({
  NODE_ENV: 'test',
  DATABASE_DIR: 'memory',
  MEDIA_DIR: mkdtempSync(join(tmpdir(), 'avero-media-')),
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-000',
  PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret',
  SIMULATION_TOOLS: 'true',
  WEB_ORIGIN: 'http://localhost:5173',
});

export async function createTestApp(): Promise<FastifyInstance> {
  const database = await openDatabase('memory');
  const app = await buildApp({ env: testEnv, database });
  app.addHook('onClose', () => database.close());
  return app;
}

/** Minimal cookie-jar client around `app.inject`. */
export function client(app: FastifyInstance) {
  const jar = new Map<string, string>();

  async function request(opts: InjectOptions & { idempotencyKey?: string }) {
    const headers: Record<string, string> = {
      'x-requested-with': 'avero',
      ...(opts.headers as Record<string, string> | undefined),
    };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    const res = await app.inject({ ...opts, headers });
    for (const c of res.cookies) {
      if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0)) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }
    return res;
  }

  return {
    jar,
    request,
    get: (url: string) => request({ method: 'GET', url }),
    post: (url: string, payload?: object, extra: { idempotencyKey?: string } = {}) =>
      request({ method: 'POST', url, payload: payload ?? {}, ...extra }),
    delete: (url: string) => request({ method: 'DELETE', url }),
  };
}

export const api = (path: string) => `/api/v1${path}`;
