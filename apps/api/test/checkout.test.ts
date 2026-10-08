import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { couponRedemptions, coupons, inventoryMovements, orders, pointsLedger, skus } from '../src/db/schema';
import {
  ADDRESS,
  NON_METRO_PIN,
  UNSERVICEABLE_PIN,
  World,
  key,
  orderOf,
  patch,
  pay,
  placeOrder,
  placed,
  readyToPlace,
} from './checkout-helpers';
import { reserveLines } from '../src/modules/inventory/reservations';
import { api, client, createTestApp } from './helpers';

let app: FastifyInstance;
let w: World;

beforeAll(async () => {
  app = await createTestApp();
  await app.ready();
  w = await new World(app).init();
});
afterAll(() => app.close());

describe('checkout session & quote', () => {
  it('refuses to start with an empty bag or a bag with blocking issues', async () => {
    const c = client(app);
    expect((await c.post(api('/checkout/session'))).json().error.code).toBe('CART_NOT_READY');
    const sku = await w.sku(2);
    await c.post(api('/cart/items'), { skuId: sku.id, qty: 1 });
    await app.ctx.db.update(skus).set({ status: 'discontinued' }).where(eq(skus.id, sku.id));
    const res = await c.post(api('/checkout/session'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CART_NOT_READY');
  });

  it('prefills members, resumes the same open session, and prices server-side', async () => {
    const { c, email } = await w.member();
    await c.post(api('/account/addresses'), { ...ADDRESS, isDefault: true });
    const sku = await w.sku(5, 1_999_00);
    await c.post(api('/cart/items'), { skuId: sku.id, qty: 1 });
    const first = (await c.post(api('/checkout/session'))).json().session;
    expect(first).toMatchObject({ isGuest: false, email, phone: '+919876543210', ready: true });
    expect(first.address.pincode).toBe(ADDRESS.pincode);
    expect(first.shippingOptions.map((o: { method: string }) => o.method)).toEqual(['standard', 'express']);
    expect((await c.post(api('/checkout/session'))).json().session.id).toBe(first.id);

    const quote = (await c.post(api(`/checkout/session/${first.id}/quote`))).json().quote;
    expect(quote).toMatchObject({ subtotalPaise: 1_999_00, shippingPaise: 0, totalPaise: 1_999_00, pointsToEarn: 19 });
    expect(quote.hash).toMatch(/^[0-9a-f]{64}$/);
    // Members can't send orders to another email.
    expect((await patch(c, first.id, { email: 'someone@else.com' })).json().error.code).toBe('VALIDATION_FAILED');
  });

  it('a new checkout for the same bag keeps the details already entered', async () => {
    const c = client(app);
    const { sessionId, quote } = await readyToPlace(c, [{ skuId: (await w.sku(5)).id, qty: 1 }], { email: 'again@example.com' });
    expect((await placeOrder(c, sessionId, quote.hash)).statusCode).toBe(201);
    const next = (await c.post(api('/checkout/session'))).json().session;
    expect(next.id).not.toBe(sessionId);
    expect(next).toMatchObject({ email: 'again@example.com', phone: '+919876543210', ready: true, quote: null });
    expect(next.pendingOrder.orderNumber).toMatch(/^AV-/);
  });

  it('rejects unserviceable PINs and express where it does not reach', async () => {
    const c = client(app);
    await c.post(api('/cart/items'), { skuId: (await w.sku(3)).id, qty: 1 });
    const { id } = (await c.post(api('/checkout/session'))).json().session;
    const bad = await patch(c, id, { address: { ...ADDRESS, pincode: UNSERVICEABLE_PIN, city: 'Port Blair', state: 'Andaman & Nicobar Islands' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('PINCODE_NOT_SERVICEABLE');
    await patch(c, id, { email: 'g@example.com', address: { ...ADDRESS, pincode: NON_METRO_PIN, city: 'Jaipur', state: 'Rajasthan' } });
    const express = await patch(c, id, { shippingMethod: 'express' });
    expect(express.json().error.code).toBe('SHIPPING_METHOD_UNAVAILABLE');
  });

  it('switches back to standard when the new address has no express delivery', async () => {
    const c = client(app);
    await c.post(api('/cart/items'), { skuId: (await w.sku(3)).id, qty: 1 });
    const { id } = (await c.post(api('/checkout/session'))).json().session;
    await patch(c, id, { email: 'g@example.com', address: ADDRESS, shippingMethod: 'express' });
    const moved = (await patch(c, id, { address: { ...ADDRESS, pincode: NON_METRO_PIN, city: 'Jaipur', state: 'Rajasthan' } })).json().session;
    expect(moved.shippingMethod).toBe('standard');
  });
});

describe('buy now', () => {
  const buyNow = (c: ReturnType<typeof client>, skuId: string, qty = 1) => c.post(api('/checkout/session'), { buyNow: { skuId, qty } });

  it('checks out only the chosen item, leaving the rest of the bag alone', async () => {
    const c = client(app);
    const inBag = await w.sku(5, 2_499_00);
    const chosen = await w.sku(5, 1_999_00);
    await c.post(api('/cart/items'), { skuId: inBag.id, qty: 2 });

    const started = await buyNow(c, chosen.id);
    expect(started.statusCode, started.body).toBe(200);
    const session = started.json().session;
    expect(session).toMatchObject({ mode: 'buy_now', subtotalPaise: 1_999_00 });
    expect(session.items.map((i: { skuId: string; qty: number }) => [i.skuId, i.qty])).toEqual([[chosen.id, 1]]);
    // Refresh resumes the same session; the bag's own checkout is separate.
    expect((await buyNow(c, chosen.id)).json().session.id).toBe(session.id);
    const bagSession = (await c.post(api('/checkout/session'))).json().session;
    expect(bagSession).toMatchObject({ mode: 'bag', subtotalPaise: 2 * 2_499_00 });
    expect(bagSession.id).not.toBe(session.id);

    await patch(c, session.id, { email: 'buynow@example.com', phone: '9876543210', address: ADDRESS });
    const quote = (await c.post(api(`/checkout/session/${session.id}/quote`))).json().quote;
    expect(quote.lines.map((l: { skuId: string }) => l.skuId)).toEqual([chosen.id]);
    expect(quote.subtotalPaise).toBe(1_999_00);

    const res = await placeOrder(c, session.id, quote.hash);
    expect(res.statusCode, res.body).toBe(201);
    const order = res.json().order;
    expect(order.items.map((i: { skuId: string }) => i.skuId)).toEqual([chosen.id]);
    expect(await w.stock(inBag.id)).toEqual({ onHand: 5, reserved: 0 });
    expect(await w.stock(chosen.id)).toEqual({ onHand: 5, reserved: 1 });
    // The pending buy-now order isn't offered as "resume payment" for the bag.
    expect((await c.post(api('/checkout/session'))).json().session.pendingOrder).toBeNull();

    // Paying never trims the bag, even if it holds the same SKU.
    await c.post(api('/cart/items'), { skuId: chosen.id, qty: 1 });
    await pay(c, order.orderNumber, 'success');
    await w.elapse(2);
    expect((await orderOf(c, order.orderNumber)).status).toBe('CONFIRMED');
    const bag = (await c.get(api('/cart'))).json().cart;
    expect(bag.lines.map((l: { skuId: string; qty: number }) => [l.skuId, l.qty])).toEqual([
      [inBag.id, 2],
      [chosen.id, 1],
    ]);
  });

  it('works for a guest with no bag yet, and refuses sold-out or unavailable items', async () => {
    const c = client(app);
    const sku = await w.sku(1);
    const started = await buyNow(c, sku.id, 3);
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().session).toMatchObject({ mode: 'buy_now', isGuest: true, items: [{ skuId: sku.id, qty: 1 }] }); // clamped to stock

    const soldOut = await w.sku(0);
    const res = await buyNow(c, soldOut.id);
    expect(res.json().error).toMatchObject({ code: 'SKU_OUT_OF_STOCK', message: 'This item just sold out' });
    const gone = await w.sku(3);
    await app.ctx.db.update(skus).set({ status: 'discontinued' }).where(eq(skus.id, gone.id));
    expect((await buyNow(c, gone.id)).json().error.code).toBe('SKU_UNAVAILABLE');
  });
});

describe('coupons', () => {
  it('reports the precise reason a coupon cannot be applied', async () => {
    const c = client(app);
    await c.post(api('/cart/items'), { skuId: (await w.sku(5, 1_000_00)).id, qty: 1 });
    const { id } = (await c.post(api('/checkout/session'))).json().session;
    await patch(c, id, { email: 'coupons@example.com', address: ADDRESS });
    const now = app.ctx.clock.now().getTime();
    const expired = await w.coupon({ kind: 'percent', value: 2000, endsAt: new Date(now - 1000) });
    const future = await w.coupon({ kind: 'percent', value: 2000, startsAt: new Date(now + 86_400_000) });
    const min = await w.coupon({ kind: 'flat', value: 500_00, minOrderPaise: 4_999_00 });
    const full = await w.coupon({ kind: 'flat', value: 100_00, usageLimit: 1 });
    await app.ctx.db.update(coupons).set({ usedCount: 1 }).where(eq(coupons.id, full.id));

    const codeFor = async (couponCode: string) => (await patch(c, id, { couponCode })).json().error?.code;
    expect(await codeFor('NOPE')).toBe('COUPON_NOT_FOUND');
    expect(await codeFor(expired.code)).toBe('COUPON_EXPIRED');
    expect(await codeFor(future.code)).toBe('COUPON_NOT_STARTED');
    expect(await codeFor(min.code)).toBe('COUPON_MIN_NOT_MET');
    expect(await codeFor(full.code)).toBe('COUPON_LIMIT_REACHED');

    const ok = await w.coupon({ kind: 'percent', value: 1000 });
    const applied = await patch(c, id, { couponCode: ok.code.toLowerCase() });
    expect(applied.json().session.couponCode).toBe(ok.code);
    const quote = (await c.post(api(`/checkout/session/${id}/quote`))).json().quote;
    expect(quote.couponDiscountPaise).toBe(100_00);
    expect(quote.coupon.code).toBe(ok.code);
  });

  it('flags a coupon in the quote when the bag drops below its minimum', async () => {
    const c = client(app);
    const sku = await w.sku(5, 3_000_00);
    const coupon = await w.coupon({ kind: 'flat', value: 300_00, minOrderPaise: 5_000_00 });
    const { sessionId, quote } = await readyToPlace(c, [{ skuId: sku.id, qty: 2 }], { coupon: coupon.code });
    expect(quote.couponDiscountPaise).toBe(300_00);
    const line = (await c.get(api('/cart'))).json().cart.lines[0];
    await c.request({ method: 'PATCH', url: api(`/cart/items/${line.id}`), payload: { qty: 1 } });
    const after = (await c.post(api(`/checkout/session/${sessionId}/quote`))).json().quote;
    expect(after.coupon).toBeNull();
    expect(after.couponError.code).toBe('COUPON_MIN_NOT_MET');
    expect(after.couponDiscountPaise).toBe(0);
  });

  it('enforces first-order-only and per-buyer limits by email, even for guests', async () => {
    const email = 'repeat@example.com';
    const first = await w.coupon({ kind: 'percent', value: 1000, firstOrderOnly: true, perUserLimit: 5 });
    const once = await w.coupon({ kind: 'flat', value: 100_00, perUserLimit: 1 });

    const a = client(app);
    const { order } = await placed(a, [{ skuId: (await w.sku(5)).id, qty: 1 }], { email, coupon: once.code });
    await pay(a, order.orderNumber, 'success');
    await w.elapse(2);
    expect((await orderOf(a, order.orderNumber)).status).toBe('CONFIRMED');

    const b = client(app);
    await b.post(api('/cart/items'), { skuId: (await w.sku(5)).id, qty: 1 });
    const { id } = (await b.post(api('/checkout/session'))).json().session;
    await patch(b, id, { email, address: ADDRESS });
    expect((await patch(b, id, { couponCode: first.code })).json().error.code).toBe('COUPON_NOT_APPLICABLE');
    expect((await patch(b, id, { couponCode: once.code })).json().error.code).toBe('COUPON_LIMIT_REACHED');
  });

  it('lets exactly usageLimit concurrent orders redeem a limited coupon', async () => {
    const coupon = await w.coupon({ kind: 'percent', value: 1500, usageLimit: 2 });
    const shoppers = await Promise.all(
      [1, 2, 3].map(async () => {
        const c = client(app);
        const ready = await readyToPlace(c, [{ skuId: (await w.sku(5)).id, qty: 1 }], { coupon: coupon.code });
        return { c, ...ready };
      }),
    );
    const results = await Promise.all(shoppers.map((s) => placeOrder(s.c, s.sessionId, s.quote.hash)));
    const codes = results.map((r) => (r.statusCode === 201 ? 'ok' : r.json().error.code)).sort();
    expect(codes).toEqual(['COUPON_LIMIT_REACHED', 'ok', 'ok']);
    const row = await app.ctx.db.query.coupons.findFirst({ where: eq(coupons.id, coupon.id) });
    expect(row!.usedCount).toBe(2);
    const redemptions = await app.ctx.db.query.couponRedemptions.findMany({ where: eq(couponRedemptions.couponId, coupon.id) });
    expect(redemptions).toHaveLength(2);
  });

  it('rejects a coupon that expired between quote and placement', async () => {
    const c = client(app);
    const coupon = await w.coupon({ kind: 'flat', value: 200_00 });
    const sku = await w.sku(3);
    const { sessionId, quote } = await readyToPlace(c, [{ skuId: sku.id, qty: 1 }], { coupon: coupon.code });
    expect((await c.post(api(`/dev/coupons/${coupon.code}/expire`))).statusCode).toBe(200);
    const res = await placeOrder(c, sessionId, quote.hash);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('COUPON_EXPIRED');
    expect(res.json().error.details.quote.coupon).toBeNull();
    expect(await w.stock(sku.id)).toEqual({ onHand: 3, reserved: 0 });
  });
});

describe('place order', () => {
  it('reserves stock, snapshots the order and is idempotent per key', async () => {
    const c = client(app);
    const sku = await w.sku(4, 2_499_00);
    const { sessionId, quote } = await readyToPlace(c, [{ skuId: sku.id, qty: 2 }]);
    const k = key('place');
    const res = await placeOrder(c, sessionId, quote.hash, k);
    expect(res.statusCode).toBe(201);
    const order = res.json().order;
    expect(order.orderNumber).toMatch(/^AV-\d{4}-[0-9A-Z]{5}$/);
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', subtotalPaise: 4_998_00, totalPaise: quote.totalPaise, canPay: true });
    expect(order.items[0]).toMatchObject({ skuId: sku.id, qty: 2, productName: 'Drift Runner', colorName: 'Bone', unitPricePaise: 2_499_00 });
    expect(await w.stock(sku.id)).toEqual({ onHand: 4, reserved: 2 });
    const moves = await app.ctx.db.query.inventoryMovements.findMany({ where: eq(inventoryMovements.skuId, sku.id) });
    expect(moves.map((m) => [m.reason, m.deltaReserved])).toEqual([['reserve', 2]]);

    // Same key → same response, no second order.
    const replay = await placeOrder(c, sessionId, quote.hash, k);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().order.orderNumber).toBe(order.orderNumber);
    // Same key, different body → rejected.
    const reused = await c.post(api('/checkout/place-order'), { sessionId, quoteHash: 'f'.repeat(64) }, { idempotencyKey: k });
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // New key, same session → already placed.
    const again = await placeOrder(c, sessionId, quote.hash);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details.orderNumber).toBe(order.orderNumber);
    expect(await w.stock(sku.id)).toEqual({ onHand: 4, reserved: 2 });
    const all = await app.ctx.db.query.orders.findMany({ where: eq(orders.checkoutSessionId, sessionId) });
    expect(all).toHaveLength(1);
  });

  it('requires an Idempotency-Key', async () => {
    const c = client(app);
    const { sessionId, quote } = await readyToPlace(c, [{ skuId: (await w.sku(2)).id, qty: 1 }]);
    const res = await c.post(api('/checkout/place-order'), { sessionId, quoteHash: quote.hash });
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('lets exactly one of two shoppers take the last unit, before anyone pays', async () => {
    const sku = await w.sku(1);
    const a = client(app);
    const b = client(app);
    const qa = await readyToPlace(a, [{ skuId: sku.id, qty: 1 }]);
    const qb = await readyToPlace(b, [{ skuId: sku.id, qty: 1 }]);
    const [ra, rb] = await Promise.all([placeOrder(a, qa.sessionId, qa.quote.hash), placeOrder(b, qb.sessionId, qb.quote.hash)]);
    const statuses = [ra.statusCode, rb.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = ra.statusCode === 409 ? ra : rb;
    expect(loser.json().error.code).toBe('SKU_OUT_OF_STOCK');
    expect(await w.stock(sku.id)).toEqual({ onHand: 1, reserved: 1 });
  });

  it('the conditional reserve refuses more than is available (all lines or none)', async () => {
    const plenty = await w.sku(5);
    const scarce = await w.sku(1);
    const attempt = app.ctx.db.transaction((tx) =>
      reserveLines(
        tx,
        null as unknown as string,
        [
          { skuId: plenty.id, qty: 2, sizeLabel: plenty.sizeLabel, productName: 'Drift Runner' },
          { skuId: scarce.id, qty: 2, sizeLabel: scarce.sizeLabel, productName: 'Drift Runner' },
        ],
        app.ctx.clock.now(),
      ),
    );
    await expect(attempt).rejects.toMatchObject({ code: 'SKU_OUT_OF_STOCK', details: { lines: [{ skuId: scarce.id, requested: 2, available: 1 }] } });
    expect(await w.stock(plenty.id)).toEqual({ onHand: 5, reserved: 0 });
  });

  it('rejects a changed price with a diff and accepts the re-confirmed quote', async () => {
    const c = client(app);
    const sku = await w.sku(3, 3_000_00);
    const { sessionId, quote } = await readyToPlace(c, [{ skuId: sku.id, qty: 1 }]);
    await c.post(api(`/dev/skus/${sku.skuCode}`), { pricePaise: 3_200_00 });
    const res = await placeOrder(c, sessionId, quote.hash);
    expect(res.statusCode).toBe(409);
    const { code, details } = res.json().error;
    expect(code).toBe('QUOTE_CHANGED');
    expect(details.changes).toContainEqual(expect.objectContaining({ type: 'price', fromPaise: 3_000_00, toPaise: 3_200_00 }));
    expect(details.changes).toContainEqual(expect.objectContaining({ type: 'total', fromPaise: 3_000_00, toPaise: 3_200_00 }));
    expect(details.quote.totalPaise).toBe(3_200_00);
    expect(await w.stock(sku.id)).toEqual({ onHand: 3, reserved: 0 });

    // The fresh quote was stored; confirming it (new key) places the order at the new price.
    const ok = await placeOrder(c, sessionId, details.quote.hash);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().order.totalPaise).toBe(3_200_00);
  });

  it('rejects an expired quote with a fresh one', async () => {
    const c = client(app);
    const { sessionId, quote } = await readyToPlace(c, [{ skuId: (await w.sku(3)).id, qty: 1 }]);
    await w.elapse(11 * 60);
    const res = await placeOrder(c, sessionId, quote.hash);
    expect(res.json().error.code).toBe('QUOTE_EXPIRED');
    const ok = await placeOrder(c, sessionId, res.json().error.details.quote.hash);
    expect(ok.statusCode).toBe(201);
  });

  it('rejects placement when stock dropped below the confirmed quantity', async () => {
    const c = client(app);
    const sku = await w.sku(3);
    const { sessionId, quote } = await readyToPlace(c, [{ skuId: sku.id, qty: 3 }]);
    await c.post(api(`/dev/skus/${sku.skuCode}`), { onHand: 2 });
    const res = await placeOrder(c, sessionId, quote.hash);
    expect(res.json().error.code).toBe('SKU_OUT_OF_STOCK');
    expect(res.json().error.details.lines).toEqual([{ skuId: sku.id, requested: 3, available: 2 }]);
  });

  it('a session change after quoting invalidates the confirmed hash', async () => {
    const c = client(app);
    const { sessionId, quote } = await readyToPlace(c, [{ skuId: (await w.sku(3)).id, qty: 1 }]);
    await patch(c, sessionId, { phone: '9123456780' });
    expect((await placeOrder(c, sessionId, quote.hash)).json().error.code).toBe('QUOTE_CHANGED');
  });
});

describe('points', () => {
  it('caps redemption, redeems inside the order and records pending earn on payment', async () => {
    const { c, email } = await w.member();
    await c.post(api('/dev/points/grant'), { email, points: 2_000 });
    const sku = await w.sku(3, 5_000_00);
    const { sessionId, quote } = await readyToPlace(c, [{ skuId: sku.id, qty: 1 }], { points: 2_000 });
    expect(quote.points).toEqual({ balance: 2_000, maxRedeemable: 1_000, redeemed: 1_000 });
    expect(quote.totalPaise).toBe(4_000_00);
    expect(quote.pointsToEarn).toBe(40);
    expect((await patch(c, sessionId, { pointsToRedeem: 5_000 })).json().error.code).toBe('POINTS_INSUFFICIENT');

    const fresh = (await c.post(api(`/checkout/session/${sessionId}/quote`))).json().quote;
    const res = await placeOrder(c, sessionId, fresh.hash);
    expect(res.statusCode).toBe(201);
    const order = res.json().order;
    expect(order).toMatchObject({ pointsRedeemed: 1_000, pointsDiscountPaise: 1_000_00, totalPaise: 4_000_00 });
    const redeem = await app.ctx.db.query.pointsLedger.findFirst({ where: and(eq(pointsLedger.orderId, order.id), eq(pointsLedger.kind, 'redeem')) });
    expect(redeem).toMatchObject({ delta: -1_000, status: 'available' });

    await pay(c, order.orderNumber, 'success');
    await w.elapse(2);
    const done = await orderOf(c, order.orderNumber);
    expect(done.status).toBe('CONFIRMED');
    expect(done.pointsEarned).toBe(40);
    const earn = await app.ctx.db.query.pointsLedger.findFirst({ where: and(eq(pointsLedger.orderId, order.id), eq(pointsLedger.kind, 'earn')) });
    expect(earn).toMatchObject({ delta: 40, status: 'pending' });
  });

  it('guests cannot redeem points', async () => {
    const c = client(app);
    await c.post(api('/cart/items'), { skuId: (await w.sku(3)).id, qty: 1 });
    const { id } = (await c.post(api('/checkout/session'))).json().session;
    expect((await patch(c, id, { pointsToRedeem: 10 })).json().error.code).toBe('UNAUTHENTICATED');
  });
});

describe('order access', () => {
  it('guest device, signed lookup link, and claim after verification', async () => {
    const email = 'guest-claim@example.com';
    const guest = client(app);
    const { order } = await placed(guest, [{ skuId: (await w.sku(3)).id, qty: 1 }], { email });
    await pay(guest, order.orderNumber, 'success');
    await w.elapse(2);

    expect((await orderOf(guest, order.orderNumber)).isGuest).toBe(true);
    const stranger = client(app);
    expect((await stranger.get(api(`/orders/${order.orderNumber}`))).statusCode).toBe(404);
    expect((await stranger.post(api('/orders/lookup'), { orderNumber: order.orderNumber, email: 'wrong@example.com' })).statusCode).toBe(404);
    const found = await stranger.post(api('/orders/lookup'), { orderNumber: order.orderNumber.toLowerCase(), email: email.toUpperCase() });
    expect(found.statusCode).toBe(200);
    const viaLink = await stranger.get(api(`/orders/${order.orderNumber}?token=${found.json().token}`));
    expect(viaLink.statusCode).toBe(200);
    expect((await stranger.get(api(`/orders/${order.orderNumber}?token=1.bad`))).statusCode).toBe(404);

    const { c: unverified } = await w.member({ email });
    expect((await unverified.post(api('/orders/claim'))).statusCode).toBe(403);
    await app.ctx.db.execute(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
    const list = (await unverified.get(api('/orders'))).json();
    expect(list.claimable).toBe(1);
    expect((await unverified.post(api('/orders/claim'))).json().claimed).toBe(1);
    const mine = (await unverified.get(api('/orders'))).json();
    expect(mine.orders.map((o: { orderNumber: string }) => o.orderNumber)).toContain(order.orderNumber);
    expect(mine.claimable).toBe(0);
  });

  it('the confirmation email links guests to a signed order page', async () => {
    const email = 'mail-link@example.com';
    const c = client(app);
    const { order } = await placed(c, [{ skuId: (await w.sku(3)).id, qty: 1 }], { email });
    await pay(c, order.orderNumber, 'success');
    await w.elapse(2);
    const mails = (await c.get(api('/dev/emails'))).json().emails.filter((m: { to: string }) => m.to === email);
    expect(mails[0].subject).toBe(`Order ${order.orderNumber} confirmed`);
    const token = /token=([\w.]+)/.exec(mails[0].text)![1];
    expect((await client(app).get(api(`/orders/${order.orderNumber}?token=${token}`))).statusCode).toBe(200);
  });
});
