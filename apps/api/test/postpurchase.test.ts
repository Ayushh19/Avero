import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { couponRedemptions, orderItems, orders, pointsLedger, refunds, sentEmails, skus } from '../src/db/schema';
import { createRefund } from '../src/modules/refunds/service';
import { World, key, orderOf, pay, placed, type Client } from './checkout-helpers';
import { api, client, createTestApp } from './helpers';

let app: FastifyInstance;
let w: World;

beforeAll(async () => {
  app = await createTestApp();
  await app.ready();
  w = await new World(app).init();
});
afterAll(() => app.close());

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Places and pays for an order; returns it CONFIRMED. */
async function confirmed(c: Client, lines: { skuId: string; qty: number }[], opts: Parameters<typeof placed>[2] = {}) {
  const { order } = await placed(c, lines, opts);
  await pay(c, order.orderNumber, 'success');
  await w.elapse(2);
  const o = await orderOf(c, order.orderNumber);
  expect(o.status).toBe('CONFIRMED');
  return o;
}

const advance = (c: Client, orderNumber: string) => c.post(api(`/dev/orders/${orderNumber}/advance`));
async function deliver(c: Client, orderNumber: string) {
  for (let i = 0; i < 4; i++) expect((await advance(c, orderNumber)).statusCode).toBe(200);
  const o = await orderOf(c, orderNumber);
  expect(o.status).toBe('DELIVERED');
  return o;
}
const cancel = (c: Client, orderNumber: string, body: object, k = key('cancel')) =>
  c.post(api(`/orders/${orderNumber}/cancel`), body, { idempotencyKey: k });
const requestReturn = (c: Client, body: object, k = key('ret')) => c.post(api('/returns'), body, { idempotencyKey: k });
const refundsOf = (orderId: string) => app.ctx.db.query.refunds.findMany({ where: eq(refunds.orderId, orderId) });
const emailsTo = async (to: string) => (await app.ctx.db.query.sentEmails.findMany({ where: eq(sentEmails.to, to) })).map((e) => e.template);

describe('fulfilment', () => {
  it('moves through packed → shipped → out for delivery → delivered on realistic dates', async () => {
    const { c, email } = await w.member();
    const o = await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);

    await w.elapse(3 * HOUR + 60);
    expect((await orderOf(c, o.orderNumber)).status).toBe('PACKED');
    await w.elapse(16 * HOUR);
    const shipped = await orderOf(c, o.orderNumber);
    expect(shipped.status).toBe('SHIPPED');
    expect(shipped.canCancel).toBe(false);
    expect(shipped.shipments[0]).toMatchObject({ kind: 'forward', carrier: expect.stringContaining('BlueTrail'), status: 'in_transit' });
    expect(shipped.shipments[0].trackingNumber).toMatch(/^BT[0-9A-Z]{10}$/);

    await w.elapse(8 * DAY);
    const done = await orderOf(c, o.orderNumber);
    expect(done.status).toBe('DELIVERED');
    expect(done.items.every((i: { status: string }) => i.status === 'DELIVERED')).toBe(true);
    expect(new Date(done.deliveredAt).getTime()).toBeLessThanOrEqual(new Date(o.expectedDeliveryAt).getTime());
    expect(new Date(done.returnWindowEndsAt).getTime() - new Date(done.deliveredAt).getTime()).toBe(15 * DAY * 1000);
    expect(done.shipments[0].events.map((e: { status: string }) => e.status)).toEqual(['delivered', 'out_for_delivery', 'arrived', 'picked_up']);
    expect(done.canReturn).toBe(true);
    expect(await emailsTo(email)).toEqual(expect.arrayContaining(['order_confirmed', 'order_shipped', 'order_out_for_delivery', 'order_delivered']));
    const notes = (await c.get(api('/notifications'))).json();
    expect(notes.notifications.map((n: { title: string }) => n.title)).toEqual(
      expect.arrayContaining([`Order ${o.orderNumber} was delivered`, `Order ${o.orderNumber} has shipped`]),
    );
  });

  it('the dev advance button performs one step; the scheduled job for it is then a no-op', async () => {
    const c = client(app);
    const o = await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);
    expect((await advance(c, o.orderNumber)).json().status).toBe('PACKED');
    await w.elapse(4 * HOUR);
    const after = await orderOf(c, o.orderNumber);
    expect(after.status).toBe('PACKED');
    expect(after.events.filter((e: { type: string }) => e.type === 'order_packed')).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('full cancel before shipping: restock, coupon released, refund incl. shipping, idempotent', async () => {
    const c = client(app);
    const sku = await w.sku(5, 1_500_00);
    const coupon = await w.coupon({ kind: 'flat', value: 100_00, usageLimit: 5 });
    // Express so the order has a shipping fee to refund (standard delivery is free).
    const o = await confirmed(c, [{ skuId: sku.id, qty: 1 }], { coupon: coupon.code, shippingMethod: 'express' });
    expect(o.shippingPaise).toBe(199_00);
    expect(await w.stock(sku.id)).toEqual({ onHand: 4, reserved: 0 });

    const k = key('cancel');
    const res = await cancel(c, o.orderNumber, { reason: 'changed_mind' }, k);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().order).toMatchObject({ status: 'CANCELLED', canCancel: false });
    expect(await w.stock(sku.id)).toEqual({ onHand: 5, reserved: 0 });
    expect((await app.ctx.db.query.couponRedemptions.findFirst({ where: eq(couponRedemptions.orderId, o.id) }))!.status).toBe('released');
    expect((await cancel(c, o.orderNumber, { reason: 'changed_mind' }, k)).headers['idempotent-replayed']).toBe('true');
    expect((await cancel(c, o.orderNumber, { reason: 'changed_mind' })).json().error.code).toBe('ORDER_NOT_CANCELLABLE');

    await w.elapse(1);
    const [refund] = await refundsOf(o.id);
    expect(refund).toMatchObject({ amountPaise: o.paidPaise, status: 'COMPLETED', reason: 'cancellation', attempts: 1 });
    expect((await orderOf(c, o.orderNumber)).refundedPaise).toBe(o.paidPaise);
  });

  it('partial cancel refunds exactly the line’s share; cancelling the rest refunds shipping and releases the coupon', async () => {
    const c = client(app);
    const a = await w.sku(5, 1_234_57);
    const b = await w.sku(5, 1_111_11);
    const coupon = await w.coupon({ kind: 'percent', value: 1000, usageLimit: 5 });
    const o = await confirmed(c, [{ skuId: a.id, qty: 1 }, { skuId: b.id, qty: 1 }], { coupon: coupon.code });
    const [lineA, lineB] = o.items;

    const first = (await cancel(c, o.orderNumber, { itemIds: [lineA.id], reason: 'wrong_size' })).json().order;
    expect(first.status).toBe('CONFIRMED');
    expect(first.items.map((i: { status: string }) => i.status)).toEqual(['CANCELLED', 'ACTIVE']);
    await w.elapse(1);
    expect((await refundsOf(o.id))[0]!.amountPaise).toBe(lineA.totalPaise);
    expect((await app.ctx.db.query.couponRedemptions.findFirst({ where: eq(couponRedemptions.orderId, o.id) }))!.status).toBe('active');

    const rest = (await cancel(c, o.orderNumber, { itemIds: [lineB.id], reason: 'changed_mind' })).json().order;
    expect(rest.status).toBe('CANCELLED');
    await w.elapse(1);
    const all = await refundsOf(o.id);
    expect(all.map((r) => r.amountPaise).sort((x, y) => x - y)).toEqual([lineA.totalPaise, lineB.totalPaise + o.shippingPaise].sort((x, y) => x - y));
    expect(all.reduce((s, r) => s + r.amountPaise, 0)).toBe(o.paidPaise);
    expect((await orderOf(c, o.orderNumber)).refundedPaise).toBe(o.paidPaise);
    expect((await app.ctx.db.query.couponRedemptions.findFirst({ where: eq(couponRedemptions.orderId, o.id) }))!.status).toBe('released');
  });

  it('cannot cancel once shipped, or cancel an item twice', async () => {
    const c = client(app);
    const o = await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }, { skuId: (await w.sku(5)).id, qty: 1 }]);
    await cancel(c, o.orderNumber, { itemIds: [o.items[0].id], reason: 'other' });
    expect((await cancel(c, o.orderNumber, { itemIds: [o.items[0].id], reason: 'other' })).json().error.code).toBe('ORDER_NOT_CANCELLABLE');
    await advance(c, o.orderNumber);
    await advance(c, o.orderNumber);
    const res = await cancel(c, o.orderNumber, { reason: 'other' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'ORDER_NOT_CANCELLABLE', message: expect.stringContaining('already shipped') });
  });

  it('returns redeemed points and shrinks / voids pending earned points', async () => {
    const { c, email } = await w.member();
    await c.post(api('/dev/points/grant'), { email, points: 1_000 });
    const o = await confirmed(c, [{ skuId: (await w.sku(5, 3_000_00)).id, qty: 1 }, { skuId: (await w.sku(5, 2_000_00)).id, qty: 1 }], { points: 1_000 });
    expect(o.pointsRedeemed).toBe(1_000);
    const earn = () => app.ctx.db.query.pointsLedger.findFirst({ where: and(eq(pointsLedger.orderId, o.id), eq(pointsLedger.kind, 'earn')) });
    expect((await earn())!.delta).toBe(40);

    await cancel(c, o.orderNumber, { itemIds: [o.items[0].id], reason: 'other' });
    expect((await earn())!.delta).toBe(16); // ₹1,600 kept (₹2,000 − its ₹400 points share)
    await cancel(c, o.orderNumber, { reason: 'other' });
    expect((await earn())!.status).toBe('void');
    const credits = await app.ctx.db.query.pointsLedger.findMany({ where: and(eq(pointsLedger.orderId, o.id), eq(pointsLedger.kind, 'refund_credit')) });
    expect(credits.reduce((s, r) => s + r.delta, 0)).toBe(1_000);
  });

  it('guests can cancel from their device', async () => {
    const c = client(app);
    const o = await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);
    expect((await cancel(client(app), o.orderNumber, { reason: 'other' })).statusCode).toBe(404);
    expect((await cancel(c, o.orderNumber, { reason: 'other' })).json().order.status).toBe('CANCELLED');
  });
});

describe('refunds', () => {
  it('a failing bank refund is retried with backoff until it succeeds', async () => {
    const { c, email } = await w.member();
    const o = await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);
    await c.post(api('/dev/refunds/failure-mode'), { failures: 2 });
    await cancel(c, o.orderNumber, { reason: 'other' });
    await w.elapse(1);
    expect((await refundsOf(o.id))[0]).toMatchObject({ status: 'FAILED', attempts: 1, failureReason: 'bank_unavailable' });
    expect(await emailsTo(email)).toContain('refund_delayed');
    await w.elapse(5 * 60);
    expect((await refundsOf(o.id))[0]).toMatchObject({ status: 'FAILED', attempts: 2 });
    await w.elapse(20 * 60);
    expect((await refundsOf(o.id))[0]).toMatchObject({ status: 'COMPLETED', attempts: 3, destination: 'original' });
    expect(await emailsTo(email)).toContain('refund_completed');
  });

  it('after 3 failures a member is refunded in points', async () => {
    const { c } = await w.member();
    const o = await confirmed(c, [{ skuId: (await w.sku(5, 2_500_50)).id, qty: 1 }]);
    await c.post(api('/dev/refunds/failure-mode'), { failures: 5 });
    await cancel(c, o.orderNumber, { reason: 'other' });
    await w.elapse(1);
    await w.elapse(5 * 60);
    await w.elapse(20 * 60);
    const [r] = await refundsOf(o.id);
    expect(r).toMatchObject({ status: 'COMPLETED', destination: 'points', attempts: 3 });
    const credit = await app.ctx.db.query.pointsLedger.findFirst({ where: and(eq(pointsLedger.orderId, o.id), eq(pointsLedger.kind, 'refund_credit')) });
    expect(credit).toMatchObject({ delta: Math.ceil(o.paidPaise / 100), status: 'available' });
    expect((await orderOf(c, o.orderNumber)).refundedPaise).toBe(o.paidPaise);
    await c.post(api('/dev/refunds/failure-mode'), { failures: 0 });
  });

  it('a guest refund keeps retrying (no points to fall back to)', async () => {
    const c = client(app);
    const o = await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);
    await c.post(api('/dev/refunds/failure-mode'), { failures: 3 });
    await cancel(c, o.orderNumber, { reason: 'other' });
    await w.elapse(1);
    await w.elapse(5 * 60);
    await w.elapse(20 * 60);
    expect((await refundsOf(o.id))[0]).toMatchObject({ status: 'FAILED', attempts: 3 });
    await w.elapse(6 * HOUR);
    expect((await refundsOf(o.id))[0]).toMatchObject({ status: 'COMPLETED', destination: 'original', attempts: 4 });
  });

  it('refunds can never exceed the amount paid', async () => {
    const c = client(app);
    const o = await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);
    const row = (await app.ctx.db.query.orders.findFirst({ where: eq(orders.id, o.id) }))!;
    const attempt = app.ctx.db.transaction((tx) =>
      createRefund(app.ctx, tx, { order: row, amountPaise: row.paidPaise + 1, destination: 'original', reason: 'return', key: key('over') }),
    );
    await expect(attempt).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_PAID' });
  });
});

describe('returns', () => {
  it('return → pickup → received → inspected → refund; stock back, earn voided, shipping kept', async () => {
    const { c } = await w.member();
    const sku = await w.sku(5, 1_800_00);
    const o = await deliver(c, (await confirmed(c, [{ skuId: sku.id, qty: 1 }])).orderNumber);
    const options = (await c.get(api(`/orders/${o.orderNumber}/return-options`))).json();
    expect(options).toMatchObject({ windowOpen: true, pointsRefundAllowed: true });
    expect(options.items[0]).toMatchObject({ returnable: true, reason: null });

    const k = key('ret');
    const body = { orderNumber: o.orderNumber, kind: 'return', items: [{ orderItemId: o.items[0].id, reason: 'too_small' }] };
    const res = await requestReturn(c, body, k);
    expect(res.statusCode, res.body).toBe(201);
    const ret = res.json().return;
    expect(ret).toMatchObject({ kind: 'return', status: 'PICKUP_SCHEDULED', refundPaise: o.items[0].totalPaise, canCancel: true });
    expect(ret.rmaNumber).toMatch(/^RMA-\d{4}-[0-9A-Z]{5}$/);
    expect((await requestReturn(c, body, k)).json().return.rmaNumber).toBe(ret.rmaNumber);
    expect((await requestReturn(c, body)).json().error.code).toBe('RETURN_NOT_ELIGIBLE');
    expect((await orderOf(c, o.orderNumber)).items[0].status).toBe('RETURN_REQUESTED');

    await w.elapse(2 * DAY);
    await w.elapse(3 * DAY);
    await w.elapse(2 * DAY);
    const done = (await c.get(api(`/returns/${ret.rmaNumber}`))).json().return;
    expect(done.status).toBe('COMPLETED');
    expect(done.timeline.map((t: { status: string }) => t.status)).toEqual(['REQUESTED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'INSPECTED', 'COMPLETED']);
    expect(done.refund).toMatchObject({ status: 'COMPLETED', amountPaise: o.items[0].totalPaise });
    expect(await w.stock(sku.id)).toEqual({ onHand: 5, reserved: 0 });
    const after = await orderOf(c, o.orderNumber);
    expect(after.items[0].status).toBe('REFUNDED');
    expect(after.refundedPaise).toBe(o.items[0].totalPaise); // shipping not refunded on returns
    expect(after.pointsEarned).toBe(0);
    expect((await c.get(api('/returns'))).json().returns[0]).toMatchObject({ rmaNumber: ret.rmaNumber, status: 'COMPLETED', itemCount: 1 });
  });

  it('members can take the refund as points, completed straight away', async () => {
    const { c } = await w.member();
    const o = await deliver(c, (await confirmed(c, [{ skuId: (await w.sku(5, 999_50)).id, qty: 1 }])).orderNumber);
    const ret = (await requestReturn(c, { orderNumber: o.orderNumber, kind: 'return', refundDestination: 'points', items: [{ orderItemId: o.items[0].id, reason: 'quality' }] })).json().return;
    for (let i = 0; i < 3; i++) await c.post(api(`/dev/returns/${ret.rmaNumber}/advance`));
    const done = (await c.get(api(`/returns/${ret.rmaNumber}`))).json().return;
    expect(done.refund).toMatchObject({ status: 'COMPLETED', destination: 'points' });
    const credit = await app.ctx.db.query.pointsLedger.findFirst({ where: and(eq(pointsLedger.orderId, o.id), eq(pointsLedger.kind, 'refund_credit')) });
    expect(credit!.delta).toBe(Math.ceil(o.items[0].totalPaise / 100));
  });

  it('guests return to the original payment only', async () => {
    const c = client(app);
    const o = await deliver(c, (await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }])).orderNumber);
    const item = [{ orderItemId: o.items[0].id, reason: 'too_large' }];
    expect((await requestReturn(c, { orderNumber: o.orderNumber, kind: 'return', refundDestination: 'points', items: item })).json().error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await requestReturn(client(app), { orderNumber: o.orderNumber, kind: 'return', items: item })).statusCode).toBe(404);
    expect((await requestReturn(c, { orderNumber: o.orderNumber, kind: 'return', items: item })).statusCode).toBe(201);
  });

  it('enforces the window, final sale and delivery', async () => {
    const c = client(app);
    const pending = await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);
    const notYet = await requestReturn(c, { orderNumber: pending.orderNumber, kind: 'return', items: [{ orderItemId: pending.items[0].id, reason: 'other' }] });
    expect(notYet.json().error.code).toBe('RETURN_NOT_ELIGIBLE');

    const o = await deliver(c, (await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }, { skuId: (await w.sku(5)).id, qty: 1 }])).orderNumber);
    await app.ctx.db.update(orderItems).set({ isFinalSale: true }).where(eq(orderItems.id, o.items[1].id));
    const options = (await c.get(api(`/orders/${o.orderNumber}/return-options`))).json();
    expect(options.items[1]).toMatchObject({ returnable: false, reason: 'Final-sale items can’t be returned' });
    const sale = await requestReturn(c, { orderNumber: o.orderNumber, kind: 'return', items: [{ orderItemId: o.items[1].id, reason: 'other' }] });
    expect(sale.json().error.code).toBe('RETURN_NOT_ELIGIBLE');

    await w.elapse(16 * DAY);
    const late = await requestReturn(c, { orderNumber: o.orderNumber, kind: 'return', items: [{ orderItemId: o.items[0].id, reason: 'other' }] });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toMatchObject({ code: 'RETURN_WINDOW_CLOSED', message: expect.stringContaining('Return window closed on') });
    expect((await orderOf(c, o.orderNumber)).canReturn).toBe(false);
  });

  it('cancelling before pickup puts items back; after pickup it is refused', async () => {
    const c = client(app);
    const o = await deliver(c, (await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }])).orderNumber);
    const body = { orderNumber: o.orderNumber, kind: 'return', items: [{ orderItemId: o.items[0].id, reason: 'other' }] };
    const first = (await requestReturn(c, body)).json().return;
    const cancelled = (await c.post(api(`/returns/${first.rmaNumber}/cancel`))).json().return;
    expect(cancelled.status).toBe('CANCELLED');
    expect((await orderOf(c, o.orderNumber)).items[0].status).toBe('DELIVERED');

    const second = (await requestReturn(c, body)).json().return;
    await c.post(api(`/dev/returns/${second.rmaNumber}/advance`));
    expect((await c.post(api(`/returns/${second.rmaNumber}/cancel`))).statusCode).toBe(409);
  });
});

describe('exchanges', () => {
  it('reserves the new size at request and ships a zero-value replacement after inspection', async () => {
    const { c } = await w.member();
    const price = 2_222_00;
    const original = await w.sku(5, price);
    const target = await w.sku(2, price);
    const pricier = await w.sku(5, price + 100_00);
    const o = await deliver(c, (await confirmed(c, [{ skuId: original.id, qty: 1 }])).orderNumber);

    const options = (await c.get(api(`/orders/${o.orderNumber}/return-options`))).json().items[0].exchangeOptions;
    expect(options.map((x: { skuId: string }) => x.skuId)).toContain(target.id);
    expect(options.map((x: { skuId: string }) => x.skuId)).not.toContain(pricier.id);
    const ex = (skuId: string) => ({ orderNumber: o.orderNumber, kind: 'exchange', items: [{ orderItemId: o.items[0].id, reason: 'too_small', exchangeSkuId: skuId }] });
    expect((await requestReturn(c, ex(pricier.id))).json().error.code).toBe('EXCHANGE_UNAVAILABLE');

    const res = await requestReturn(c, ex(target.id));
    expect(res.statusCode, res.body).toBe(201);
    const ret = res.json().return;
    expect(ret.items[0].exchangeFor).toMatchObject({ sizeLabel: target.sizeLabel });
    expect(await w.stock(target.id)).toEqual({ onHand: 2, reserved: 1 });
    expect((await orderOf(c, o.orderNumber)).items[0].status).toBe('EXCHANGE_REQUESTED');

    for (let i = 0; i < 3; i++) await c.post(api(`/dev/returns/${ret.rmaNumber}/advance`));
    const done = (await c.get(api(`/returns/${ret.rmaNumber}`))).json().return;
    expect(done.status).toBe('COMPLETED');
    expect(done.refund).toBeNull();
    expect(await w.stock(target.id)).toEqual({ onHand: 1, reserved: 0 });
    expect(await w.stock(original.id)).toEqual({ onHand: 5, reserved: 0 });
    expect((await orderOf(c, o.orderNumber)).items[0].status).toBe('EXCHANGED');

    const replacement = await orderOf(c, done.replacementOrderNumber);
    expect(replacement).toMatchObject({ kind: 'exchange', parentOrderNumber: o.orderNumber, status: 'CONFIRMED', totalPaise: 0, paidPaise: 0, canCancel: false });
    expect(replacement.items[0]).toMatchObject({ skuId: target.id, unitPricePaise: price, totalPaise: 0 });
    const delivered = await deliver(c, replacement.orderNumber);
    expect(delivered.canReturn).toBe(false);
    expect(delivered.invoiceAvailable).toBe(false);
  });

  it('EXCHANGE_UNAVAILABLE when the size sold out; cancelling releases the hold', async () => {
    const c = client(app);
    const price = 2_333_00;
    const o = await deliver(c, (await confirmed(c, [{ skuId: (await w.sku(5, price)).id, qty: 1 }])).orderNumber);
    const gone = await w.sku(0, price);
    const ex = (skuId: string) => ({ orderNumber: o.orderNumber, kind: 'exchange', items: [{ orderItemId: o.items[0].id, reason: 'too_large', exchangeSkuId: skuId }] });
    const res = await requestReturn(c, ex(gone.id));
    expect(res.json().error).toMatchObject({ code: 'EXCHANGE_UNAVAILABLE', message: expect.stringContaining('return the item instead') });

    const spare = await w.sku(1, price);
    const ret = (await requestReturn(c, ex(spare.id))).json().return;
    expect(await w.stock(spare.id)).toEqual({ onHand: 1, reserved: 1 });
    await c.post(api(`/returns/${ret.rmaNumber}/cancel`));
    expect(await w.stock(spare.id)).toEqual({ onHand: 1, reserved: 0 });
  });
});

describe('notifications', () => {
  it('lists, counts and marks read', async () => {
    const { c } = await w.member();
    const o = await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);
    await advance(c, o.orderNumber);
    const list = (await c.get(api('/notifications'))).json();
    expect(list.unreadCount).toBe(2);
    expect(list.notifications[0]).toMatchObject({ kind: 'order', title: `Order ${o.orderNumber} is packed`, readAt: null, link: `/account/orders/${o.orderNumber}` });
    expect((await c.post(api('/notifications/read'), { ids: [list.notifications[0].id] })).json().unreadCount).toBe(1);
    expect((await c.post(api('/notifications/read'), { all: true })).json().unreadCount).toBe(0);
    expect((await client(app).get(api('/notifications'))).statusCode).toBe(401);
  });

  it('respects preferences; transactional email cannot be switched off', async () => {
    const { c, email } = await w.member();
    const prefs = (await c.request({ method: 'PUT', url: api('/notifications/preferences'), payload: { preferences: [{ kind: 'order', inApp: false, email: false }, { kind: 'stock_alert', inApp: true, email: false }] } })).json().preferences;
    expect(prefs.find((p: { kind: string }) => p.kind === 'order')).toMatchObject({ inApp: false, email: true, emailLocked: true });
    expect(prefs.find((p: { kind: string }) => p.kind === 'stock_alert')).toMatchObject({ inApp: true, email: false, emailLocked: false });

    await confirmed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);
    expect((await c.get(api('/notifications'))).json().notifications).toHaveLength(0);
    expect(await emailsTo(email)).toContain('order_confirmed');

    const sold = await w.sku(0);
    expect((await c.post(api('/alerts/stock'), { skuId: sold.id })).statusCode).toBeLessThan(300);
    await c.post(api(`/dev/skus/${sold.skuCode}`), { onHand: 3 });
    await w.elapse(1);
    expect(await emailsTo(email)).not.toContain('back_in_stock');
    expect((await c.get(api('/notifications'))).json().notifications[0]).toMatchObject({ kind: 'stock_alert' });
  });
});

describe('invoice', () => {
  it('renders a GST invoice (IGST out of state, CGST+SGST in Karnataka) once paid', async () => {
    const c = client(app);
    const { order } = await placed(c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);
    expect((await c.get(api(`/orders/${order.orderNumber}/invoice`))).statusCode).toBe(404);
    await pay(c, order.orderNumber, 'success');
    await w.elapse(2);
    const intra = await c.get(api(`/orders/${order.orderNumber}/invoice`));
    expect(intra.headers['content-type']).toContain('text/html');
    expect(intra.body).toContain('GSTIN 29AAVCA0000A1Z5');
    expect(intra.body).toContain('<th>CGST</th><th>SGST</th>');

    const other = client(app);
    const out = await confirmed(other, [{ skuId: (await w.sku(5)).id, qty: 1 }], { address: { pincode: '302001', city: 'Jaipur', state: 'Rajasthan' } as never });
    const html = (await other.get(api(`/orders/${out.orderNumber}/invoice`))).body;
    expect(html).toContain('<th>IGST</th>');
    expect((await client(app).get(api(`/orders/${out.orderNumber}/invoice`))).statusCode).toBe(404);
  });
});

describe('invariants', () => {
  it('no background job failed and refunds never exceed payments', async () => {
    await w.elapse(DAY);
    const failed = (await app.ctx.db.query.jobs.findMany()).filter((j) => j.status === 'failed' || j.lastError);
    expect(failed.map((j) => [j.type, j.lastError])).toEqual([]);
    for (const o of await app.ctx.db.select().from(orders)) expect(o.refundedPaise).toBeLessThanOrEqual(o.paidPaise);
    for (const s of await app.ctx.db.select().from(skus)) expect(s.reserved).toBeGreaterThanOrEqual(0);
  });
});
