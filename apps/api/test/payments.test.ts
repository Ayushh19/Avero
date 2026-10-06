import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  couponRedemptions,
  coupons,
  jobs,
  orderEvents,
  orders,
  paymentAttempts,
  paymentEvents,
  pointsLedger,
  refunds,
  sentEmails,
  skus,
} from '../src/db/schema';
import { AppError } from '../src/lib/errors';
import { transitionOrder } from '../src/lib/transitions';
import { signWebhook } from '../src/modules/payments/gateway-sim/service';
import { World, key, orderOf, pay, placed, startPayment, type Client } from './checkout-helpers';
import { api, client, createTestApp, testEnv } from './helpers';

let app: FastifyInstance;
let w: World;

beforeAll(async () => {
  app = await createTestApp();
  await app.ready();
  w = await new World(app).init();
});
afterAll(() => app.close());

const attemptStatus = async (c: Client, id: string) => (await c.get(api(`/payments/attempts/${id}`))).json();
const eventsOf = async (orderId: string) =>
  (await app.ctx.db.query.orderEvents.findMany({ where: eq(orderEvents.orderId, orderId) })).map((e) => e.type);

/** A guest order for `qty` units of a fresh SKU, optionally with a coupon. */
async function guestOrder(opts: { stock?: number; qty?: number; coupon?: string } = {}) {
  const c = client(app);
  const sku = await w.sku(opts.stock ?? 5);
  const { order } = await placed(c, [{ skuId: sku.id, qty: opts.qty ?? 1 }], { coupon: opts.coupon });
  return { c, sku, order };
}

function signedPost(body: object, secret = testEnv.PAYMENT_WEBHOOK_SECRET, at = app.ctx.clock.now()) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: api('/payments/webhook'),
    headers: { 'content-type': 'application/json', 'x-avero-signature': signWebhook(secret, raw, Math.floor(at.getTime() / 1000)) },
    payload: raw,
  });
}

describe('payment scenarios', () => {
  it('success: webhook confirms the order, commits stock, trims the bag, emails', async () => {
    const { c, sku, order } = await guestOrder({ stock: 5, qty: 2 });
    // Shopper added another pair and saved one for later after placing the order.
    const { cart } = (await c.post(api('/cart/items'), { skuId: sku.id, qty: 1 })).json();
    expect(cart.lines[0].qty).toBe(3);

    const { attempt, redirectUrl } = await pay(c, order.orderNumber, 'success');
    expect(redirectUrl).toBe(`/checkout/processing/${attempt.id}`);
    expect((await attemptStatus(c, attempt.id)).attempt.status).toBe('CREATED');
    await w.elapse(2);

    const status = await attemptStatus(c, attempt.id);
    expect(status.attempt.status).toBe('SUCCEEDED');
    expect(status.order.status).toBe('CONFIRMED');
    const done = await orderOf(c, order.orderNumber);
    expect(done).toMatchObject({ paidPaise: order.totalPaise, canPay: false });
    expect(done.expectedDeliveryAt).toBeTruthy();
    expect(done.events.map((e: { type: string }) => e.type)).toEqual(['order_placed', 'payment_started', 'payment_succeeded', 'order_confirmed']);
    expect(await w.stock(sku.id)).toEqual({ onHand: 3, reserved: 0 });
    // Bag keeps only what wasn't bought (3 − 2).
    const bag = (await c.get(api('/cart'))).json().cart;
    expect(bag.lines).toHaveLength(1);
    expect(bag.lines[0].qty).toBe(1);
    const mail = await app.ctx.db.query.sentEmails.findFirst({ where: eq(sentEmails.subject, `Order ${order.orderNumber} confirmed`) });
    expect(mail).toBeTruthy();
  });

  it('success_no_redirect: no browser return, order still confirmed server-side', async () => {
    const { c, order } = await guestOrder();
    const { redirectUrl } = await pay(c, order.orderNumber, 'success_no_redirect');
    expect(redirectUrl).toBeNull();
    await w.elapse(2);
    expect((await orderOf(c, order.orderNumber)).status).toBe('CONFIRMED');
  });

  it.each([
    ['failure_declined', 'card_declined'],
    ['failure_insufficient', 'insufficient_funds'],
  ])('%s: attempt fails, order keeps its reservation, one-click retry succeeds', async (scenario, reason) => {
    const { c, sku, order } = await guestOrder({ stock: 2 });
    const { attempt } = await pay(c, order.orderNumber, scenario);
    await w.elapse(2);
    const failed = await attemptStatus(c, attempt.id);
    expect(failed.attempt).toMatchObject({ status: 'FAILED', failureReason: reason });
    expect(failed.order).toMatchObject({ status: 'PAYMENT_FAILED', canPay: true });
    expect(await w.stock(sku.id)).toEqual({ onHand: 2, reserved: 1 });
    expect((await c.get(api('/cart'))).json().cart.lines[0].qty).toBe(1); // bag untouched

    const retry = await pay(c, order.orderNumber, 'success');
    await w.elapse(2);
    expect((await attemptStatus(c, retry.attempt.id)).order.status).toBe('CONFIRMED');
    expect(await eventsOf(order.id)).toEqual(
      expect.arrayContaining(['payment_failed', 'payment_retry', 'payment_succeeded', 'order_confirmed']),
    );
  });

  it('cancelled: shopper cancels on the gateway page', async () => {
    const { c, order } = await guestOrder();
    const { attempt } = await pay(c, order.orderNumber, 'cancelled');
    await w.elapse(0);
    const s = await attemptStatus(c, attempt.id);
    expect(s.attempt).toMatchObject({ status: 'CANCELLED', failureReason: 'user_cancelled' });
    expect(s.order.status).toBe('PAYMENT_FAILED');
  });

  it('pending: settles later; a second attempt is refused while it is in flight', async () => {
    const { c, order } = await guestOrder();
    const { attempt } = await pay(c, order.orderNumber, 'pending');
    await w.elapse(2);
    const pending = await attemptStatus(c, attempt.id);
    expect(pending.attempt.status).toBe('PENDING');
    expect(pending.order).toMatchObject({ status: 'PENDING_PAYMENT', canPay: false });
    expect((await startPayment(c, order.orderNumber)).json().error.code).toBe('PAYMENT_IN_PROGRESS');
    await w.elapse(30);
    expect((await attemptStatus(c, attempt.id)).order.status).toBe('CONFIRMED');
  });

  it('pending → failure', async () => {
    const { c, order } = await guestOrder();
    const { attempt } = await pay(c, order.orderNumber, 'pending', { pendingResolution: 'failure' });
    await w.elapse(31);
    const s = await attemptStatus(c, attempt.id);
    expect(s.attempt).toMatchObject({ status: 'FAILED', failureReason: 'bank_declined_after_pending' });
    expect(s.order.status).toBe('PAYMENT_FAILED');
  });

  it('timeout: no webhook; reconciliation expires the attempt, then the reservation lapses', async () => {
    const coupon = await w.coupon({ kind: 'flat', value: 100_00, usageLimit: 10 });
    const { c, sku, order } = await guestOrder({ coupon: coupon.code });
    const { attempt } = await pay(c, order.orderNumber, 'timeout');
    await w.elapse(5 * 60);
    expect((await attemptStatus(c, attempt.id)).attempt.status).toBe('CREATED');

    await w.elapse(6 * 60); // attempt TTL (10 min) + reconcile grace passed; reservation (15 min) alive
    const timedOut = await attemptStatus(c, attempt.id);
    expect(timedOut.attempt).toMatchObject({ status: 'EXPIRED', failureReason: 'timeout' });
    expect(timedOut.order).toMatchObject({ status: 'PAYMENT_FAILED', canPay: true });

    await w.elapse(5 * 60);
    const expired = await orderOf(c, order.orderNumber);
    expect(expired).toMatchObject({ status: 'EXPIRED', canPay: false });
    expect(await w.stock(sku.id)).toEqual({ onHand: 5, reserved: 0 });
    expect((await app.ctx.db.query.coupons.findFirst({ where: eq(coupons.id, coupon.id) }))!.usedCount).toBe(0);
    expect((await c.get(api('/cart'))).json().cart.lines).toHaveLength(1);
    expect((await startPayment(c, order.orderNumber)).json().error.code).toBe('ORDER_NOT_PAYABLE');
  });

  it('duplicate_webhook: three deliveries of one event are applied once', async () => {
    const { c, sku, order } = await guestOrder({ stock: 3 });
    const { attempt } = await pay(c, order.orderNumber, 'duplicate_webhook');
    await w.elapse(5);
    expect((await attemptStatus(c, attempt.id)).order.status).toBe('CONFIRMED');
    const received = await app.ctx.db.query.paymentEvents.findMany({ where: eq(paymentEvents.attemptId, attempt.id) });
    expect(received).toHaveLength(1);
    expect((await eventsOf(order.id)).filter((t) => t === 'payment_succeeded')).toHaveLength(1);
    expect(await w.stock(sku.id)).toEqual({ onHand: 2, reserved: 0 });
  });
});

describe('reservation expiry & late success', () => {
  it('unpaid order expires: stock, coupon and points released, bag intact', async () => {
    const { c, email } = await w.member();
    await c.post(api('/dev/points/grant'), { email, points: 300 });
    const coupon = await w.coupon({ kind: 'flat', value: 100_00, usageLimit: 5 });
    const sku = await w.sku(4);
    const { order } = await placed(c, [{ skuId: sku.id, qty: 2 }], { coupon: coupon.code, points: 300 });
    expect(order.pointsRedeemed).toBe(300);
    await w.elapse(15 * 60);

    const expired = await orderOf(c, order.orderNumber);
    expect(expired.status).toBe('EXPIRED');
    expect(await w.stock(sku.id)).toEqual({ onHand: 4, reserved: 0 });
    expect((await app.ctx.db.query.couponRedemptions.findFirst({ where: eq(couponRedemptions.orderId, order.id) }))!.status).toBe('released');
    expect((await app.ctx.db.query.coupons.findFirst({ where: eq(coupons.id, coupon.id) }))!.usedCount).toBe(0);
    const redeem = await app.ctx.db.query.pointsLedger.findFirst({ where: and(eq(pointsLedger.orderId, order.id), eq(pointsLedger.kind, 'redeem')) });
    expect(redeem!.status).toBe('void');
    expect((await c.get(api('/cart'))).json().cart.lines[0].qty).toBe(2);
    // Expired, unpaid orders stay out of order history.
    expect((await c.get(api('/orders'))).json().orders).toHaveLength(0);
  });

  it('an unsubmitted attempt is voided at expiry', async () => {
    const { c, order } = await guestOrder();
    const res = await startPayment(c, order.orderNumber);
    await w.elapse(15 * 60);
    expect((await attemptStatus(c, res.json().attempt.id)).attempt).toMatchObject({ status: 'EXPIRED', failureReason: 'order_expired' });
    const page = await c.get(api(`/payments/sim/${res.json().attempt.gatewayRef}`));
    expect(page.json().charge.status).toBe('expired');
    expect((await c.post(api(`/payments/sim/${res.json().attempt.gatewayRef}/submit`), { scenario: 'success' })).statusCode).toBe(409);
  });

  it('late success with stock still available: re-reserved and confirmed, offers re-taken', async () => {
    const coupon = await w.coupon({ kind: 'flat', value: 100_00, usageLimit: 5 });
    const { c, sku, order } = await guestOrder({ stock: 3, coupon: coupon.code });
    const { attempt } = await pay(c, order.orderNumber, 'late_success');
    await w.elapse(15 * 60);
    expect((await orderOf(c, order.orderNumber)).status).toBe('EXPIRED');
    expect(await w.stock(sku.id)).toEqual({ onHand: 3, reserved: 0 });

    await w.elapse(2 * 60);
    const s = await attemptStatus(c, attempt.id);
    expect(s.attempt.status).toBe('SUCCEEDED');
    expect(s.order.status).toBe('CONFIRMED');
    expect(await w.stock(sku.id)).toEqual({ onHand: 2, reserved: 0 });
    expect(await eventsOf(order.id)).toEqual(expect.arrayContaining(['order_expired', 'late_payment_succeeded', 'order_confirmed']));
    expect((await app.ctx.db.query.couponRedemptions.findFirst({ where: eq(couponRedemptions.orderId, order.id) }))!.status).toBe('active');
  });

  it('late success after the coupon filled up: price honoured, recorded', async () => {
    const coupon = await w.coupon({ kind: 'flat', value: 100_00, usageLimit: 1 });
    const { c, order } = await guestOrder({ coupon: coupon.code });
    await pay(c, order.orderNumber, 'late_success');
    await w.elapse(15 * 60);
    // Someone else takes the last redemption while this order is expired.
    await placed(client(app), [{ skuId: (await w.sku(2)).id, qty: 1 }], { coupon: coupon.code });
    await w.elapse(2 * 60);
    const done = await orderOf(c, order.orderNumber);
    expect(done).toMatchObject({ status: 'CONFIRMED', discountPaise: 100_00, paidPaise: order.totalPaise });
    expect(await eventsOf(order.id)).toContain('coupon_honoured_over_limit');
  });

  it('late success after stock sold out: PAID_UNFULFILLABLE → CANCELLED with a full refund', async () => {
    const { c, sku, order } = await guestOrder({ stock: 1 });
    const { attempt } = await pay(c, order.orderNumber, 'late_success');
    await w.elapse(15 * 60);
    const other = client(app);
    const rival = await placed(other, [{ skuId: sku.id, qty: 1 }]);
    await pay(other, rival.order.orderNumber, 'success');
    await w.elapse(2 * 60);

    const s = await attemptStatus(c, attempt.id);
    expect(s.attempt.status).toBe('SUCCEEDED');
    const done = await orderOf(c, order.orderNumber);
    expect(done.status).toBe('CANCELLED');
    expect(done.items[0].status).toBe('CANCELLED');
    expect(done.events.map((e: { toStatus: string | null }) => e.toStatus)).toEqual(
      expect.arrayContaining(['EXPIRED', 'PAID', 'PAID_UNFULFILLABLE', 'CANCELLED']),
    );
    const refund = await app.ctx.db.query.refunds.findFirst({ where: eq(refunds.orderId, order.id) });
    // Refunds are processed since Phase 4: the money goes back through the gateway.
    expect(refund).toMatchObject({ amountPaise: order.totalPaise, status: 'COMPLETED', reason: 'unfulfillable' });
    expect((await orderOf(c, order.orderNumber)).refundedPaise).toBe(order.totalPaise);
    expect(await w.stock(sku.id)).toEqual({ onHand: 0, reserved: 0 });
    const mail = await app.ctx.db.query.sentEmails.findFirst({ where: eq(sentEmails.template, 'order_unfulfillable') });
    expect(mail?.subject).toContain(order.orderNumber);
  });

  it('reconciliation never revives an expired order itself; it asks the gateway to redeliver', async () => {
    const { c, order } = await guestOrder();
    const { attempt } = await pay(c, order.orderNumber, 'late_success');
    await w.elapse(15 * 60);
    // The merchant endpoint is down when the success webhook is first sent.
    const transport = app.ctx.webhookTransport;
    app.ctx.webhookTransport = async () => 503;
    await w.elapse(2 * 60);
    expect((await attemptStatus(c, attempt.id)).attempt.status).toBe('CREATED');
    app.ctx.webhookTransport = transport;
    // Reconcile runs, sees "succeeded" for an expired order → requests redelivery → webhook applies it.
    await w.elapse(10 * 60);
    const s = await attemptStatus(c, attempt.id);
    expect(s.order.status).toBe('CONFIRMED');
    expect(await eventsOf(order.id)).toContain('late_payment_redelivery_requested');
  });
});

describe('payment attempts', () => {
  it('same Idempotency-Key returns the same attempt; switching method supersedes an unsubmitted one', async () => {
    const { c, order } = await guestOrder();
    const k = key('pay');
    const first = await startPayment(c, order.orderNumber, 'card', k);
    const replay = await startPayment(c, order.orderNumber, 'card', k);
    expect(replay.json().attempt.id).toBe(first.json().attempt.id);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const upi = await startPayment(c, order.orderNumber, 'upi');
    expect(upi.statusCode).toBe(201);
    const old = await app.ctx.db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, first.json().attempt.id) });
    expect(old).toMatchObject({ status: 'CANCELLED', failureReason: 'superseded' });
  });

  it('a submitted attempt blocks a new one even before any webhook', async () => {
    const { c, order } = await guestOrder();
    await pay(c, order.orderNumber, 'success');
    expect((await startPayment(c, order.orderNumber)).json().error.code).toBe('PAYMENT_IN_PROGRESS');
  });

  it('other shoppers cannot pay for or poll someone else’s order', async () => {
    const { c, order } = await guestOrder();
    const res = await startPayment(c, order.orderNumber);
    const stranger = client(app);
    expect((await startPayment(stranger, order.orderNumber)).statusCode).toBe(404);
    expect((await stranger.get(api(`/payments/attempts/${res.json().attempt.id}`))).statusCode).toBe(404);
  });

  it('a paid order cannot be paid again', async () => {
    const { c, order } = await guestOrder();
    await pay(c, order.orderNumber, 'success');
    await w.elapse(2);
    expect((await startPayment(c, order.orderNumber)).json().error.code).toBe('ORDER_NOT_PAYABLE');
  });
});

describe('webhook', () => {
  async function succeededOrder() {
    const { c, order } = await guestOrder();
    const { attempt } = await pay(c, order.orderNumber, 'success');
    await w.elapse(2);
    return { c, order, attempt };
  }
  const event = (gatewayRef: string, type: string, id = `evt_test_${key()}`, amountPaise = 0) => ({
    id,
    type,
    createdAt: app.ctx.clock.now().toISOString(),
    data: { gatewayRef, amountPaise },
  });

  it('rejects bad signatures and stale timestamps', async () => {
    const { attempt } = await succeededOrder();
    const body = event(attempt.gatewayRef, 'payment.failed', undefined, attempt.amountPaise);
    expect((await signedPost(body, 'wrong-secret-0000')).statusCode).toBe(401);
    const stale = new Date(app.ctx.clock.now().getTime() - 10 * 60_000);
    expect((await signedPost(body, undefined, stale)).statusCode).toBe(401);
    const unsigned = await app.inject({ method: 'POST', url: api('/payments/webhook'), headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect(unsigned.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('ignores a late failure after success, and acknowledges replays without side effects', async () => {
    const { c, order, attempt } = await succeededOrder();
    const late = event(attempt.gatewayRef, 'payment.failed', undefined, attempt.amountPaise);
    const res = await signedPost(late);
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe('attempt_already_terminal');
    expect((await orderOf(c, order.orderNumber)).status).toBe('CONFIRMED');
    const again = await signedPost(late);
    expect(again.json()).toMatchObject({ received: true, duplicate: true });
    expect((await eventsOf(order.id)).filter((t) => t === 'payment_event_ignored')).toHaveLength(1);
  });

  it('ignores an event whose amount does not match the attempt', async () => {
    const { c, order } = await guestOrder();
    const res = await startPayment(c, order.orderNumber);
    const out = await signedPost(event(res.json().attempt.gatewayRef, 'payment.succeeded', undefined, 1));
    expect(out.json().ignored).toBe('amount_mismatch');
    expect((await orderOf(c, order.orderNumber)).status).toBe('PENDING_PAYMENT');
  });

  it('is exempt from CSRF but unknown payments are 404 (so the gateway retries)', async () => {
    const res = await signedPost(event('gw_doesnotexist', 'payment.succeeded'));
    expect(res.statusCode).toBe(404);
  });
});

describe('state & money invariants', () => {
  it('EXPIRED → PAID is only allowed for the late-payment webhook path', async () => {
    const { c, order } = await guestOrder();
    await w.elapse(15 * 60);
    expect((await orderOf(c, order.orderNumber)).status).toBe('EXPIRED');
    const row = (await app.ctx.db.query.orders.findFirst({ where: eq(orders.id, order.id) }))!;
    await expect(app.ctx.db.transaction((tx) => transitionOrder(app.ctx, tx, row, 'PAID', { event: 'test' }))).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
    await expect(app.ctx.db.transaction((tx) => transitionOrder(app.ctx, tx, row, 'CONFIRMED', { event: 'test' }))).rejects.toBeInstanceOf(AppError);
  });

  it('the database rejects refunds above the paid amount', async () => {
    const { order } = await guestOrder();
    await expect(app.ctx.db.update(orders).set({ paidPaise: 100, refundedPaise: 101 }).where(eq(orders.id, order.id))).rejects.toThrow();
  });

  it('order lines sum exactly to the total (discount allocation)', async () => {
    const c = client(app);
    const coupon = await w.coupon({ kind: 'percent', value: 1333 });
    const lines = [await w.sku(5, 1_234_57), await w.sku(5, 2_999_99), await w.sku(5, 777_77)];
    const { order } = await placed(c, lines.map((s, i) => ({ skuId: s.id, qty: i + 1 })), { coupon: coupon.code });
    const itemsTotal = order.items.reduce((s: number, i: { totalPaise: number }) => s + i.totalPaise, 0);
    expect(itemsTotal + order.shippingPaise).toBe(order.totalPaise);
    expect(order.items.reduce((s: number, i: { discountPaise: number }) => s + i.discountPaise, 0)).toBe(order.discountPaise);
  });

  it('no background job failed during the suite (except deliveries to the deliberately-down endpoint)', async () => {
    await w.elapse(60 * 60);
    const all = await app.ctx.db.select().from(jobs);
    const failed = all.filter((j) => j.status === 'failed');
    expect(failed).toEqual([]);
    const errored = all.filter((j) => j.lastError && !j.lastError.includes('HTTP 503'));
    expect(errored.map((j) => [j.type, j.lastError])).toEqual([]);
    for (const s of await app.ctx.db.select().from(skus)) expect(s.reserved).toBe(0); // every reservation settled
  });
});
