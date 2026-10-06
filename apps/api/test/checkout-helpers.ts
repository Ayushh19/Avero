import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { categories, colorways, coupons, products, skus, users } from '../src/db/schema';
import { api, client } from './helpers';

export type Client = ReturnType<typeof client>;

export const ADDRESS = {
  fullName: 'Riya Sharma',
  phone: '9876543210',
  line1: '12 MG Road, Indiranagar',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560038', // metro: express available
} as const;
export const NON_METRO_PIN = '302001'; // Jaipur: serviceable, standard only
export const UNSERVICEABLE_PIN = '744101'; // Andaman: not served

let seq = 0;
const next = () => ++seq;

/**
 * Isolated catalog for checkout tests: every SKU is new, so reservations left by one test never
 * interfere with another.
 */
export class World {
  private colorwayId = '';
  constructor(readonly app: FastifyInstance) {}

  productId = '';
  productSlug = '';

  /** Each World is its own product (unique slugs), so worlds can coexist in one app. */
  async init(name = 'Drift Runner'): Promise<this> {
    const { db } = this.app.ctx;
    const n = next();
    const [cat] = await db.insert(categories).values({ slug: `checkout-test-${n}`, name: 'Checkout test', path: `checkout-test-${n}` }).returning();
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${n}`;
    const [p] = await db
      .insert(products)
      .values({ slug, name, categoryId: cat!.id, status: 'active', gstRateBps: 1800, gender: 'men' })
      .returning();
    this.productId = p!.id;
    this.productSlug = slug;
    const [cw] = await db
      .insert(colorways)
      .values({ productId: p!.id, slug: 'bone', name: 'Bone', colorFamily: 'white', status: 'active' })
      .returning();
    this.colorwayId = cw!.id;
    return this;
  }

  async sku(onHand: number, pricePaise = 3_499_00) {
    const n = next();
    const [s] = await this.app.ctx.db
      .insert(skus)
      .values({
        colorwayId: this.colorwayId,
        skuCode: `DR-BONE-T${n}`,
        sizeLabel: `T${n}`,
        sizeSort: n,
        pricePaise,
        mrpPaise: Math.max(pricePaise, 4_999_00),
        onHand,
        status: 'active',
      })
      .returning();
    return s!;
  }

  async stock(skuId: string) {
    const s = await this.app.ctx.db.query.skus.findFirst({ where: eq(skus.id, skuId) });
    return { onHand: s!.onHand, reserved: s!.reserved };
  }

  async coupon(values: Partial<typeof coupons.$inferInsert> & { kind: 'percent' | 'flat' | 'free_shipping'; value: number }) {
    const code = values.code ?? `T${next()}OFF`;
    const now = this.app.ctx.clock.now();
    const [c] = await this.app.ctx.db
      .insert(coupons)
      .values({ startsAt: new Date(now.getTime() - 86_400_000), ...values, code })
      .returning();
    return c!;
  }

  /** A signed-up member (optionally verified) with a client holding their session. */
  async member(opts: { verified?: boolean; email?: string } = {}) {
    const c = client(this.app);
    const email = opts.email ?? `member${next()}@example.com`;
    // Distinct client IPs so the per-IP signup rate limit doesn't trip across many test members.
    const res = await c.request({
      method: 'POST',
      url: api('/auth/signup'),
      payload: { name: 'Riya', email, password: 'sneakers123', phone: '9876543210' },
      headers: { 'x-forwarded-for': `10.9.${Math.floor(seq / 250)}.${seq % 250}` },
    });
    expect(res.statusCode).toBe(201);
    if (opts.verified) {
      await this.app.ctx.db.update(users).set({ emailVerifiedAt: this.app.ctx.clock.now() }).where(eq(users.email, email));
    }
    return { c, email };
  }

  /** Advance the simulated clock and run every job that became due (webhooks, expiry, reconcile). */
  async elapse(seconds: number): Promise<void> {
    await this.app.ctx.clock.advance(seconds * 1000);
    await this.app.worker.runDue();
  }
}

let keySeq = 0;
export const key = (label = 'k') => `${label}-${Date.now()}-${++keySeq}`.replace(/[^A-Za-z0-9_-]/g, '');

export const patch = (c: Client, sessionId: string, body: object) =>
  c.request({ method: 'PATCH', url: api(`/checkout/session/${sessionId}`), payload: body });

/** Bag → checkout session with contact + address → quote. */
export async function readyToPlace(
  c: Client,
  lines: { skuId: string; qty: number }[],
  opts: { email?: string; coupon?: string; points?: number; address?: Partial<typeof ADDRESS>; shippingMethod?: 'standard' | 'express' } = {},
) {
  for (const l of lines) expect((await c.post(api('/cart/items'), l)).statusCode).toBe(200);
  const started = await c.post(api('/checkout/session'));
  expect(started.statusCode).toBe(200);
  const sessionId: string = started.json().session.id;
  const body: Record<string, unknown> = { phone: '9876543210', address: { ...ADDRESS, ...opts.address } };
  if (started.json().session.isGuest) body.email = opts.email ?? `guest${next()}@example.com`;
  if (opts.shippingMethod) body.shippingMethod = opts.shippingMethod;
  if (opts.coupon) body.couponCode = opts.coupon;
  if (opts.points) body.pointsToRedeem = opts.points;
  const patched = await patch(c, sessionId, body);
  expect(patched.statusCode, patched.body).toBe(200);
  const q = await c.post(api(`/checkout/session/${sessionId}/quote`));
  expect(q.statusCode, q.body).toBe(200);
  return { sessionId, quote: q.json().quote };
}

export const placeOrder = (c: Client, sessionId: string, quoteHash: string, idempotencyKey = key('place')) =>
  c.post(api('/checkout/place-order'), { sessionId, quoteHash }, { idempotencyKey });

/** Places an order and returns its number (asserting success). */
export async function placed(c: Client, lines: { skuId: string; qty: number }[], opts: Parameters<typeof readyToPlace>[2] = {}) {
  const { sessionId, quote } = await readyToPlace(c, lines, opts);
  const res = await placeOrder(c, sessionId, quote.hash);
  expect(res.statusCode, res.body).toBe(201);
  return { order: res.json().order, quote, sessionId };
}

export async function startPayment(c: Client, orderNumber: string, method = 'upi', idempotencyKey = key('pay')) {
  return c.post(api('/payments/attempts'), { orderNumber, method }, { idempotencyKey });
}

/** Creates an attempt and submits the scenario on the gateway page. */
export async function pay(c: Client, orderNumber: string, scenario: string, extra: object = {}) {
  const res = await startPayment(c, orderNumber);
  expect(res.statusCode, res.body).toBe(201);
  const attempt = res.json().attempt;
  const submit = await c.post(api(`/payments/sim/${attempt.gatewayRef}/submit`), { scenario, ...extra });
  expect(submit.statusCode, submit.body).toBe(200);
  return { attempt, redirectUrl: submit.json().redirectUrl as string | null };
}

export async function orderOf(c: Client, orderNumber: string) {
  const res = await c.get(api(`/orders/${orderNumber}`));
  expect(res.statusCode, res.body).toBe(200);
  return res.json().order;
}
