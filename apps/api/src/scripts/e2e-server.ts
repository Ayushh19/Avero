import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../app';
import { loadEnv } from '../config/env';
import { openDatabase } from '../db/client';
import { coupons } from '../db/schema';
import { addDays } from '../lib/clock';
import { importCatalog } from '../modules/catalog/importer/run';
import { sourcePackSchema } from '../modules/catalog/importer/source';
import { seedReviews } from '../modules/reviews/seed';

/**
 * Throwaway API for the end-to-end suite (`pnpm e2e`): in-memory database, the test catalogue,
 * sample coupons and reviews, background worker on. Never touches the dev database.
 */
const port = Number(process.env.E2E_API_PORT ?? 4400);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:5400';
const env = loadEnv({
  NODE_ENV: 'test',
  PORT: String(port),
  DATABASE_DIR: 'memory',
  MEDIA_DIR: mkdtempSync(join(tmpdir(), 'avero-e2e-')),
  SESSION_SECRET: 'e2e-session-secret-that-is-long-enough-0000',
  PAYMENT_WEBHOOK_SECRET: 'e2e-webhook-secret',
  SIMULATION_TOOLS: 'true',
  API_ORIGIN: `http://localhost:${port}`,
  WEB_ORIGIN: webOrigin,
});

const database = await openDatabase('memory');
const app = await buildApp({ env, database, startWorker: true });
const fixture = resolve(import.meta.dirname, '../../test/fixtures/scenesku-shoes.json');
const items = sourcePackSchema.parse(JSON.parse(readFileSync(fixture, 'utf8'))).data;
await importCatalog(app.ctx.db, app.ctx.clock, { items, mediaDir: env.MEDIA_DIR, download: async () => new Uint8Array([1]) });
const now = app.ctx.clock.now();
await app.ctx.db.insert(coupons).values([
  { code: 'WELCOME10', description: '10% off your first order (up to ₹500)', kind: 'percent', value: 1000, maxDiscountPaise: 500_00, minOrderPaise: 1_499_00, startsAt: addDays(now, -1), firstOrderOnly: true, perUserLimit: 1 },
  { code: 'FLAT500', description: '₹500 off orders above ₹4,999', kind: 'flat', value: 500_00, minOrderPaise: 4_999_00, startsAt: addDays(now, -1), perUserLimit: 50 },
]);
await seedReviews(app.ctx.db, app.ctx.clock);
await app.listen({ port, host: '127.0.0.1' });
console.log(`e2e API ready on :${port}`);
