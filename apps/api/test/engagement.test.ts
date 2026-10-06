import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coupons, orderItems, pointsLedger, products, referrals, reviewVotes, reviews, sentEmails, users } from '../src/db/schema';
import { _test as lots, expireDuePoints } from '../src/modules/loyalty/lifecycle';
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

const DAY = 86_400;
let phoneSeq = 0;

/** Sign-up with a unique phone (referral rules reject reused phones). */
async function signup(name: string, opts: { ref?: string; phone?: string } = {}) {
  const c = client(app);
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${++phoneSeq}@example.com`;
  const phone = opts.phone ?? `98${String(10_000_000 + phoneSeq).slice(-8)}`;
  const res = await c.request({
    method: 'POST',
    url: api('/auth/signup'),
    payload: { name, email, password: 'sneakers123', phone, ...(opts.ref ? { referralCode: opts.ref } : {}) },
    headers: { 'x-forwarded-for': `10.20.${Math.floor(phoneSeq / 250)}.${phoneSeq % 250}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { c, email, phone, user: res.json().user };
}

/** After a long clock jump the 30-day session has lapsed: sign in again. */
async function signIn(c: Client, email: string) {
  const res = await c.request({ method: 'POST', url: api('/auth/signin'), payload: { email, password: 'sneakers123' }, headers: { 'x-forwarded-for': `10.30.0.${++phoneSeq % 250}` } });
  expect(res.statusCode, res.body).toBe(200);
}

async function confirmedOrder(c: Client, lines: { skuId: string; qty: number }[], opts: Parameters<typeof placed>[2] = {}) {
  const { order } = await placed(c, lines, opts);
  await pay(c, order.orderNumber, 'success');
  await w.elapse(2);
  return orderOf(c, order.orderNumber);
}
async function delivered(c: Client, lines: { skuId: string; qty: number }[], opts: Parameters<typeof placed>[2] = {}) {
  const o = await confirmedOrder(c, lines, opts);
  for (let i = 0; i < 4; i++) await c.post(api(`/dev/orders/${o.orderNumber}/advance`));
  return orderOf(c, o.orderNumber);
}
const review = (c: Client, orderItemId: string, extra: object = {}) =>
  c.post(api('/reviews'), { orderItemId, rating: 4, title: 'Great everyday pair', body: 'Comfortable from day one, true to size.', fit: 'true', ...extra });
const ledger = (userId: string) => app.ctx.db.query.pointsLedger.findMany({ where: eq(pointsLedger.userId, userId) });
const product = (id: string) => app.ctx.db.query.products.findFirst({ where: eq(products.id, id) });

describe('reviews', () => {
  it('only verified buyers of delivered items can review; aggregates update with every change', async () => {
    const pw = await new World(app).init('Cloud Walker');
    const { c: stranger } = await signup('Stranger Danger');
    const { c, user } = await signup('Riya Sharma');
    const o = await delivered(c, [{ skuId: (await pw.sku(5)).id, qty: 1 }]);
    const itemId = o.items[0].id;

    expect((await review(stranger, itemId)).json().error.code).toBe('REVIEW_NOT_ELIGIBLE');
    expect((await review(client(app), itemId)).statusCode).toBe(401);
    expect((await c.get(api('/reviews/eligible'))).json().items.map((i: { orderItemId: string }) => i.orderItemId)).toContain(itemId);

    const created = await review(c, itemId, { rating: 4, fit: 'small' });
    expect(created.statusCode, created.body).toBe(201);
    expect(await product(pw.productId)).toMatchObject({ ratingAvg: '4.00', ratingCount: 1, fitSmallCount: 1 });
    expect((await review(c, itemId)).json().error.code).toBe('CONFLICT');

    const list = (await c.get(api(`/products/${pw.productSlug}/reviews`))).json();
    expect(list.summary).toMatchObject({ average: 4, count: 1, distribution: [0, 0, 0, 1, 0] });
    expect(list.reviews[0]).toMatchObject({ authorName: 'Riya S.', verified: true, mine: true, sizePurchased: expect.any(String), fit: 'small' });
    expect(list).toMatchObject({ canReview: null, myReviewId: created.json().id });

    // +25 bonus, available now, expiring in 12 months.
    const bonus = (await ledger(user.id)).find((r) => r.kind === 'bonus');
    expect(bonus).toMatchObject({ delta: 25, status: 'available' });
    expect(bonus!.expiresAt).toBeTruthy();

    await c.request({ method: 'PATCH', url: api(`/reviews/${created.json().id}`), payload: { rating: 2, fit: 'large' } });
    expect(await product(pw.productId)).toMatchObject({ ratingAvg: '2.00', ratingCount: 1, fitSmallCount: 0, fitLargeCount: 1 });

    expect((await c.delete(api(`/reviews/${created.json().id}`))).statusCode).toBe(204);
    expect(await product(pw.productId)).toMatchObject({ ratingAvg: '0.00', ratingCount: 0 });
    expect((await review(c, itemId)).statusCode).toBe(201);
    expect((await ledger(user.id)).filter((r) => r.kind === 'bonus')).toHaveLength(1); // once per product
  });

  it('returned items cannot be reviewed', async () => {
    const pw = await new World(app).init('Trail Return');
    const { c } = await signup('Kabir Rao');
    const o = await delivered(c, [{ skuId: (await pw.sku(5)).id, qty: 1 }]);
    await c.post(api('/returns'), { orderNumber: o.orderNumber, kind: 'return', items: [{ orderItemId: o.items[0].id, reason: 'too_small' }] }, { idempotencyKey: key() });
    expect((await review(c, o.items[0].id)).json().error.code).toBe('REVIEW_NOT_ELIGIBLE');
  });

  it('helpful votes: once per member, toggleable, never on your own; sort and filter', async () => {
    const pw = await new World(app).init('Vote Runner');
    const a = await signup('Asha Iyer');
    const b = await signup('Dev Mehta');
    const oa = await delivered(a.c, [{ skuId: (await pw.sku(5)).id, qty: 1 }]);
    const ob = await delivered(b.c, [{ skuId: (await pw.sku(5)).id, qty: 1 }]);
    const ra = (await review(a.c, oa.items[0].id, { rating: 5 })).json().id;
    await review(b.c, ob.items[0].id, { rating: 2 });

    expect((await b.c.post(api(`/reviews/${ra}/helpful`), { helpful: true })).json()).toEqual({ helpfulCount: 1, votedHelpful: true });
    expect((await b.c.post(api(`/reviews/${ra}/helpful`), { helpful: true })).json().helpfulCount).toBe(1);
    expect((await a.c.post(api(`/reviews/${ra}/helpful`), { helpful: true })).statusCode).toBe(403);
    expect((await b.c.post(api(`/reviews/${ra}/helpful`), { helpful: false })).json().helpfulCount).toBe(0);

    const low = (await client(app).get(api(`/products/${pw.productSlug}/reviews?sort=rating_low`))).json();
    expect(low.reviews.map((r: { rating: number }) => r.rating)).toEqual([2, 5]);
    const fives = (await client(app).get(api(`/products/${pw.productSlug}/reviews?rating=5`))).json();
    expect(fives.reviews).toHaveLength(1);
    expect(fives.summary.average).toBe(3.5);
  });

  it('a review reminder arrives 3 days after delivery, only if not reviewed yet', async () => {
    const pw = await new World(app).init('Prompt Shoe');
    const { c } = await signup('Neha Kapoor');
    const o = await delivered(c, [{ skuId: (await pw.sku(5)).id, qty: 1 }]);
    await w.elapse(3 * DAY + 60);
    const notes = (await c.get(api('/notifications'))).json().notifications;
    expect(notes.find((n: { kind: string }) => n.kind === 'review_prompt')).toMatchObject({ link: `/account/reviews/new/${o.items[0].id}` });
  });
});

describe('points lifecycle', () => {
  it('pending points become available when the return window closes, then expire after 12 months', async () => {
    const { c, user, email } = await signup('Points Person');
    const o = await delivered(c, [{ skuId: (await w.sku(5, 3_000_00)).id, qty: 1 }]);
    expect((await c.get(api('/loyalty'))).json()).toMatchObject({ balance: 0, pending: 30 });

    await w.elapse(15 * DAY + 60);
    const after = (await c.get(api('/loyalty'))).json();
    expect(after).toMatchObject({ balance: 30, pending: 0 });
    const earn = after.ledger.find((l: { kind: string }) => l.kind === 'earn');
    expect(earn).toMatchObject({ delta: 30, status: 'available', orderNumber: o.orderNumber });
    expect(new Date(earn.expiresAt).getTime() - new Date(earn.availableAt).getTime()).toBe(365 * DAY * 1000);

    await w.elapse(336 * DAY);
    await signIn(c, email);
    const soon = (await c.get(api('/loyalty'))).json();
    expect(soon.expiringSoon).toEqual([{ points: 30, on: earn.expiresAt.slice(0, 10) }]);
    expect((await c.get(api('/notifications'))).json().notifications.map((n: { title: string }) => n.title)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^30 points expire on/), '30 points are ready to use']),
    );

    await w.elapse(31 * DAY);
    await signIn(c, email);
    expect((await c.get(api('/loyalty'))).json().balance).toBe(0);
    expect((await ledger(user.id)).find((r) => r.kind === 'expire')).toMatchObject({ delta: -30 });
  });

  it('a return still in progress at window close holds the points until it finishes', async () => {
    const { c, user } = await signup('Return Holder');
    const o = await delivered(c, [{ skuId: (await w.sku(5, 2_000_00)).id, qty: 1 }, { skuId: (await w.sku(5, 1_000_00)).id, qty: 1 }]);
    await w.elapse(14 * DAY);
    const ret = (
      await c.post(api('/returns'), { orderNumber: o.orderNumber, kind: 'return', items: [{ orderItemId: o.items[0].id, reason: 'quality' }] }, { idempotencyKey: key() })
    ).json().return;
    await w.elapse(DAY + 60); // window closed, return only picked up
    expect((await ledger(user.id)).find((r) => r.kind === 'earn')!.status).toBe('pending');
    for (let i = 0; i < 3; i++) await c.post(api(`/dev/returns/${ret.rmaNumber}/advance`));
    await w.elapse(DAY + 60);
    const earn = (await ledger(user.id)).find((r) => r.kind === 'earn')!;
    expect(earn).toMatchObject({ status: 'available', delta: 10 }); // only the kept ₹1,000 line earns
  });

  it('expiry is first-expiring-first: spent points never expire; refund credits never expire', async () => {
    const { user } = await signup('Fifo Tester');
    const now = app.ctx.clock.now();
    const at = (days: number) => new Date(now.getTime() + days * DAY * 1000);
    await app.ctx.db.insert(pointsLedger).values([
      { userId: user.id, delta: 100, kind: 'bonus', status: 'available', note: 'A', availableAt: at(0), expiresAt: at(10), createdAt: at(0) },
      { userId: user.id, delta: 50, kind: 'bonus', status: 'available', note: 'B', availableAt: at(0), expiresAt: at(20), createdAt: at(0) },
      { userId: user.id, delta: 40, kind: 'refund_credit', status: 'available', note: 'refund', availableAt: at(0), expiresAt: null, createdAt: at(0) },
      { userId: user.id, delta: -120, kind: 'redeem', status: 'available', note: 'spent', availableAt: at(1), createdAt: at(1) },
    ]);
    await w.elapse(11 * DAY);
    expect(await expireDuePoints(app.ctx, user.id)).toBe(0); // all of A was spent
    await w.elapse(10 * DAY);
    expect(await expireDuePoints(app.ctx, user.id)).toBe(30); // B: 50 − 20 spent
    expect(await expireDuePoints(app.ctx, user.id)).toBe(0); // idempotent
    const remaining = lots.allocateLots(await ledger(user.id));
    expect(remaining.map((l) => [l.row.note, l.remaining])).toEqual([['A', 0], ['B', 0], ['refund', 40]]);
  });
});

describe('referrals', () => {
  it('friend gets a personal coupon; referrer earns points after the friend’s first order clears its window', async () => {
    const referrer = await signup('Meera Nair');
    const code = referrer.user.referralCode;
    expect((await client(app).get(api(`/referrals/${code}`))).json()).toMatchObject({ valid: true, referrerName: 'Meera' });
    expect((await client(app).get(api('/referrals/NOPE1234'))).json().valid).toBe(false);

    const friend = await signup('Arjun Das', { ref: code });
    const coupon = await app.ctx.db.query.coupons.findFirst({ where: eq(coupons.restrictedToUserId, friend.user.id) });
    expect(coupon).toMatchObject({ kind: 'flat', value: 250_00, minOrderPaise: 1_999_00, firstOrderOnly: true });

    // Only the friend can use it.
    const other = await signup('Not Invited');
    await other.c.post(api('/cart/items'), { skuId: (await w.sku(5, 2_500_00)).id, qty: 1 });
    const { session: os } = (await other.c.post(api('/checkout/session'))).json();
    expect((await other.c.request({ method: 'PATCH', url: api(`/checkout/session/${os.id}`), payload: { couponCode: coupon!.code } })).json().error.code).toBe('COUPON_NOT_APPLICABLE');

    await friend.c.post(api('/cart/items'), { skuId: (await w.sku(5, 2_500_00)).id, qty: 1 });
    const offered = (await friend.c.post(api('/checkout/session'))).json().session.personalCoupons;
    expect(offered).toEqual([{ code: coupon!.code, description: expect.stringContaining('Meera') }]);
    const o = await delivered(friend.c, [], { coupon: coupon!.code });
    expect(o.discountPaise).toBe(250_00);
    expect((await app.ctx.db.query.referrals.findFirst({ where: eq(referrals.refereeUserId, friend.user.id) }))).toMatchObject({ status: 'ordered', qualifyingOrderId: o.id });

    await w.elapse(15 * DAY + 60);
    const summary = (await referrer.c.get(api('/referrals'))).json();
    expect(summary).toMatchObject({ code, link: expect.stringContaining(`/r/${code}`), pointsEarned: 250 });
    expect(summary.invites[0]).toMatchObject({ name: 'Arjun D.', status: 'rewarded' });
    expect((await referrer.c.get(api('/loyalty'))).json().balance).toBe(250);
    expect((await app.ctx.db.query.sentEmails.findMany({ where: eq(sentEmails.to, referrer.email) })).map((e) => e.template)).toContain('referral_reward');
  });

  it('no self-referral, reused phones are ignored, and a cancelled qualifying order lets the next one count', async () => {
    const referrer = await signup('Ravi Kumar');
    const code = referrer.user.referralCode;
    const samePhone = await signup('Phone Reuse', { ref: code, phone: referrer.phone });
    expect(await app.ctx.db.query.referrals.findFirst({ where: eq(referrals.refereeUserId, samePhone.user.id) })).toBeUndefined();

    const friend = await signup('Sana Khan', { ref: code });
    const first = await confirmedOrder(friend.c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);
    await friend.c.post(api(`/orders/${first.orderNumber}/cancel`), { reason: 'other' }, { idempotencyKey: key() });
    expect((await app.ctx.db.query.referrals.findFirst({ where: eq(referrals.refereeUserId, friend.user.id) }))!.status).toBe('signed_up');
    const second = await confirmedOrder(friend.c, [{ skuId: (await w.sku(5)).id, qty: 1 }]);
    expect((await app.ctx.db.query.referrals.findFirst({ where: eq(referrals.refereeUserId, friend.user.id) }))).toMatchObject({ status: 'ordered', qualifyingOrderId: second.id });
    const self = await app.ctx.db.query.users.findFirst({ where: eq(users.id, referrer.user.id) });
    expect(self!.referredByUserId).toBeNull();
  });
});

describe('price-drop alerts', () => {
  it('explicit alert (guest email) fires once when the price falls below what they saw', async () => {
    const pw = await new World(app).init('Alert Runner');
    const sku = await pw.sku(5, 3_000_00);
    const guest = client(app);
    const res = await guest.post(api('/alerts/price'), { colorwayId: sku.colorwayId, email: 'watcher@example.com' });
    expect(res.json()).toMatchObject({ ok: true, baselinePricePaise: 3_000_00 });
    await guest.post(api(`/dev/skus/${sku.skuCode}`), { pricePaise: 3_200_00 });
    await w.elapse(1);
    const mails = () => app.ctx.db.query.sentEmails.findMany({ where: and(eq(sentEmails.to, 'watcher@example.com'), eq(sentEmails.template, 'price_drop')) });
    expect(await mails()).toHaveLength(0);
    await guest.post(api(`/dev/skus/${sku.skuCode}`), { pricePaise: 2_700_00 });
    await w.elapse(1);
    expect((await mails())[0]?.subject).toContain('₹2,700');
    await guest.post(api(`/dev/skus/${sku.skuCode}`), { pricePaise: 2_500_00 });
    await w.elapse(1);
    expect(await mails()).toHaveLength(1);
  });

  it('wishlist items alert on each new low, respecting the price-drop preference', async () => {
    const pw = await new World(app).init('Wish Runner');
    const sku = await pw.sku(5, 4_000_00);
    const { c, email } = await signup('Wish Lister');
    await c.request({ method: 'PUT', url: api(`/wishlist/${sku.colorwayId}`) });
    await c.request({ method: 'PUT', url: api('/notifications/preferences'), payload: { preferences: [{ kind: 'price_drop', inApp: true, email: false }] } });
    const drops = async () => (await c.get(api('/notifications'))).json().notifications.filter((n: { kind: string }) => n.kind === 'price_drop');

    await c.post(api(`/dev/skus/${sku.skuCode}`), { pricePaise: 3_500_00 });
    await w.elapse(1);
    expect((await drops())[0].title).toContain('₹3,500');
    await c.post(api(`/dev/skus/${sku.skuCode}`), { pricePaise: 3_600_00 });
    await c.post(api(`/dev/skus/${sku.skuCode}`), { pricePaise: 3_500_00 });
    await w.elapse(1);
    expect(await drops()).toHaveLength(1); // not a new low
    await c.post(api(`/dev/skus/${sku.skuCode}`), { pricePaise: 3_200_00 });
    await w.elapse(1);
    expect(await drops()).toHaveLength(2);
    expect((await app.ctx.db.query.sentEmails.findMany({ where: and(eq(sentEmails.to, email), eq(sentEmails.template, 'price_drop')) }))).toHaveLength(0);

    const rows = (await c.get(api('/home/personal'))).json().rows;
    expect(rows.find((r: { key: string }) => r.key === 'wishlist_price_drops').items[0].colorwayId).toBe(sku.colorwayId);
  });
});

describe('recommendations', () => {
  it('frequently bought together ranks co-purchases first and tops up to 3', async () => {
    const a = await new World(app).init('Pair Alpha');
    const b = await new World(app).init('Pair Beta');
    const [sa, sb] = [await a.sku(20), await b.sku(20)];
    for (let i = 0; i < 2; i++) await confirmedOrder(client(app), [{ skuId: sa.id, qty: 1 }, { skuId: sb.id, qty: 1 }]);
    app.ctx.catalog.invalidate();
    const fbt = (await client(app).get(api(`/products/${a.productSlug}/frequently-bought-together`))).json().items;
    expect(fbt).toHaveLength(3);
    expect(fbt[0].productId).toBe(b.productId);
    expect(fbt.map((i: { productId: string }) => i.productId)).not.toContain(a.productId);
  });

  it('picked for you follows what a guest viewed, excluding those products', async () => {
    const viewed = await new World(app).init('Viewed Shoe');
    const s = await viewed.sku(5);
    app.ctx.catalog.invalidate();
    const rows = (await client(app).get(api(`/home/personal?viewed=${s.colorwayId}`))).json().rows;
    const picks = rows.find((r: { key: string }) => r.key === 'picked_for_you');
    expect(picks.items.length).toBeGreaterThan(0);
    expect(picks.items.map((i: { productId: string }) => i.productId)).not.toContain(viewed.productId);
    expect((await client(app).get(api('/home/personal'))).json().rows).toEqual([]);
  });
});

describe('sample reviews', () => {
  it('seeds 4–7 verified reviews per product with consistent aggregates and votes; idempotent', async () => {
    const pw = await new World(app).init('Seeded Shoe');
    await pw.sku(10);
    const first = (await client(app).post(api('/dev/reviews/seed'))).json();
    expect(first.reviews).toBeGreaterThan(0);
    const list = (await client(app).get(api(`/products/${pw.productSlug}/reviews`))).json();
    expect(list.summary.count).toBeGreaterThanOrEqual(4);
    expect(list.summary.count).toBeLessThanOrEqual(7);
    expect(list.summary.distribution.reduce((a: number, b: number) => a + b, 0)).toBe(list.summary.count);
    expect(list.reviews.every((r: { verified: boolean }) => r.verified)).toBe(true);
    const p = await product(pw.productId);
    expect(p!.ratingCount).toBe(list.summary.count);
    for (const r of await app.ctx.db.query.reviews.findMany({ where: eq(reviews.productId, pw.productId) })) {
      const votes = await app.ctx.db.query.reviewVotes.findMany({ where: eq(reviewVotes.reviewId, r.id) });
      expect(r.helpfulCount).toBe(votes.length);
      const item = await app.ctx.db.query.orderItems.findFirst({ where: eq(orderItems.id, r.orderItemId) });
      expect(item).toMatchObject({ status: 'DELIVERED', productId: pw.productId });
    }
    const again = (await client(app).post(api('/dev/reviews/seed'))).json();
    expect(again.reviews).toBe(0);
    expect((await client(app).get(api(`/products/${pw.productSlug}/reviews`))).json().summary.count).toBe(list.summary.count);
  });
});

describe('invariants', () => {
  it('no background job failed', async () => {
    await w.elapse(DAY);
    const failed = (await app.ctx.db.query.jobs.findMany()).filter((j) => j.status === 'failed' || j.lastError);
    expect(failed.map((j) => [j.type, j.lastError])).toEqual([]);
    expect(await app.ctx.db.query.orderItems.findFirst({ where: eq(orderItems.status, 'ACTIVE') })).toBeDefined();
  });
});
