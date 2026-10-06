import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { categories, colorways, jobs, products, skus } from '../src/db/schema';
import { enqueue } from '../src/jobs/queue';
import { AppError } from '../src/lib/errors';
import { withIdempotency } from '../src/lib/idempotency';
import { api, client, createTestApp } from './helpers';

describe('idempotency', () => {
  let app: FastifyInstance;
  let calls: number;

  beforeEach(async () => {
    app = await createTestApp();
    calls = 0;
    app.post('/test/charge', (req, reply) =>
      withIdempotency(app.ctx, req, reply, 'test', async () => {
        calls++;
        const body = req.body as { amount: number; fail?: boolean };
        if (body.fail) throw new AppError('SKU_OUT_OF_STOCK', 'gone');
        return { status: 201, body: { chargeId: `ch_${calls}`, amount: body.amount } };
      }),
    );
  });
  afterEach(() => app.close());

  it('runs once and replays the stored response', async () => {
    const c = client(app);
    const first = await c.post('/test/charge', { amount: 100 }, { idempotencyKey: 'key-00000001' });
    const second = await c.post('/test/charge', { amount: 100 }, { idempotencyKey: 'key-00000001' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(calls).toBe(1);
  });

  it('rejects key reuse with a different body', async () => {
    const c = client(app);
    await c.post('/test/charge', { amount: 100 }, { idempotencyKey: 'key-00000002' });
    const res = await c.post('/test/charge', { amount: 999 }, { idempotencyKey: 'key-00000002' });
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('replays business errors too', async () => {
    const c = client(app);
    const a = await c.post('/test/charge', { amount: 1, fail: true }, { idempotencyKey: 'key-00000003' });
    const b = await c.post('/test/charge', { amount: 1, fail: true }, { idempotencyKey: 'key-00000003' });
    expect(a.statusCode).toBe(409);
    expect(b.statusCode).toBe(409);
    expect(calls).toBe(1);
  });

  it('requires a key', async () => {
    const res = await client(app).post('/test/charge', { amount: 1 });
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('job queue', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(() => app.close());

  it('retries failed jobs with backoff using the simulated clock', async () => {
    let attempts = 0;
    app.worker.register('flaky', async () => {
      attempts++;
      if (attempts < 2) throw new Error('boom');
    });
    await enqueue(app.ctx.db, 'flaky', {});

    expect(await app.worker.runDue()).toBe(1);
    expect(attempts).toBe(1);
    expect(await app.worker.runDue()).toBe(0); // waiting for backoff

    await app.ctx.clock.advance(10_000);
    await app.worker.runDue();
    expect(attempts).toBe(2);
    const [job] = await app.ctx.db.select().from(jobs);
    expect(job?.status).toBe('done');
  });

  it('ignores duplicate enqueues with the same dedupe key while pending', async () => {
    await enqueue(app.ctx.db, 'x', {}, { dedupeKey: 'order:1:advance' });
    await enqueue(app.ctx.db, 'x', {}, { dedupeKey: 'order:1:advance' });
    const rows = await app.ctx.db.select().from(jobs).where(eq(jobs.type, 'x'));
    expect(rows).toHaveLength(1);
  });

  it('marks a job failed after max attempts', async () => {
    app.worker.register('always-fails', async () => {
      throw new Error('nope');
    });
    await enqueue(app.ctx.db, 'always-fails', {}, { maxAttempts: 2 });
    await app.worker.runDue();
    await app.ctx.clock.advance(60_000);
    await app.worker.runDue();
    const [job] = await app.ctx.db.select().from(jobs);
    expect(job?.status).toBe('failed');
  });
});

describe('inventory constraints', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(() => app.close());

  async function makeSku(onHand: number) {
    const { db } = app.ctx;
    const [cat] = await db.insert(categories).values({ slug: 'running', name: 'Running', path: 'running' }).returning();
    const [p] = await db.insert(products).values({ slug: 'drift', name: 'Drift', categoryId: cat!.id }).returning();
    const [cw] = await db.insert(colorways).values({ productId: p!.id, slug: 'bone', name: 'Bone', colorFamily: 'white' }).returning();
    const [s] = await db
      .insert(skus)
      .values({ colorwayId: cw!.id, skuCode: 'DR-BONE-9', sizeLabel: '9', sizeSort: 90, pricePaise: 499900, mrpPaise: 599900, onHand })
      .returning();
    return s!;
  }

  it('conditional reserve lets exactly one buyer take the last unit', async () => {
    const sku = await makeSku(1);
    const reserve = () =>
      app.ctx.db
        .update(skus)
        .set({ reserved: sql`${skus.reserved} + 1` })
        .where(sql`${skus.id} = ${sku.id} AND ${skus.onHand} - ${skus.reserved} >= 1`)
        .returning({ id: skus.id });
    const results = await Promise.all([reserve(), reserve()]);
    expect(results.filter((r) => r.length === 1)).toHaveLength(1);
  });

  it('database rejects negative or over-reserved stock', async () => {
    const sku = await makeSku(2);
    await expect(app.ctx.db.update(skus).set({ onHand: -1 }).where(eq(skus.id, sku.id))).rejects.toThrow();
    await expect(app.ctx.db.update(skus).set({ reserved: 3 }).where(eq(skus.id, sku.id))).rejects.toThrow();
  });
});

describe('system', () => {
  it('serves health and config', async () => {
    const app = await createTestApp();
    const c = client(app);
    expect((await c.get(api('/health'))).json().status).toBe('ok');
    const config = (await c.get(api('/config'))).json();
    expect(config.freeShippingThresholdPaise).toBe(0); // standard delivery free on every order
    expect(config.auth.googleEnabled).toBe(false);
    await app.close();
  });
});
