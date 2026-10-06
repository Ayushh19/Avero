import { readFileSync } from 'node:fs';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications, sentEmails, skus } from '../src/db/schema';
import { importCatalog } from '../src/modules/catalog/importer/run';
import { sourcePackSchema } from '../src/modules/catalog/importer/source';
import { api, client, createTestApp, testEnv } from './helpers';

const fixture = sourcePackSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/scenesku-shoes.json', import.meta.url), 'utf8'))).data;

let app: FastifyInstance;
let n = 0;
const newUser = () => ({ name: 'Riya', email: `riya${++n}@example.com`, password: 'sneakers123' });

/** A SKU with at least `min` units, set to exactly `stock` units for the test. */
async function skuWith(stock: number) {
  const [sku] = await app.ctx.db.select().from(skus).where(and(eq(skus.status, 'active'), gt(skus.onHand, 0))).orderBy(sql`random()`).limit(1);
  await app.ctx.db.update(skus).set({ onHand: stock, reserved: 0, maxPerOrder: 5 }).where(eq(skus.id, sku!.id));
  app.ctx.catalog.invalidate();
  return sku!;
}

beforeAll(async () => {
  app = await createTestApp();
  await app.ready();
  await importCatalog(app.ctx.db, app.ctx.clock, { items: fixture, mediaDir: testEnv.MEDIA_DIR, download: async () => new Uint8Array([1]) });
});
afterAll(() => app.close());

describe('bag', () => {
  it('creates a guest bag on first add and computes totals server-side', async () => {
    const c = client(app);
    expect((await c.get(api('/cart'))).json().cart.lines).toEqual([]);
    const sku = await skuWith(10);
    const res = await c.post(api('/cart/items'), { skuId: sku.id, qty: 2 });
    expect(res.statusCode).toBe(200);
    expect(c.jar.has('avero_cart')).toBe(true);
    const { cart } = res.json();
    expect(cart.lines[0]).toMatchObject({ skuId: sku.id, qty: 2, lineTotalPaise: sku.pricePaise * 2 });
    expect(cart.totals.subtotalPaise).toBe(sku.pricePaise * 2);
    expect(cart.totals.shippingPaise).toBe(0); // above free-shipping threshold
    expect(cart.totals.taxIncludedPaise).toBeGreaterThan(0);
  });

  it('clamps quantity to stock with a notice, and refuses sold-out sizes', async () => {
    const c = client(app);
    const sku = await skuWith(3);
    const res = (await c.post(api('/cart/items'), { skuId: sku.id, qty: 5 })).json();
    expect(res.cart.lines[0].qty).toBe(3);
    expect(res.notice).toMatch(/Only 3 are available/);
    const again = await c.post(api('/cart/items'), { skuId: sku.id, qty: 1 });
    expect(again.json().error.code).toBe('SKU_OUT_OF_STOCK');

    const gone = await skuWith(0);
    const sold = await c.post(api('/cart/items'), { skuId: gone.id, qty: 1 });
    expect(sold.statusCode).toBe(409);
    expect(sold.json().error.code).toBe('SKU_OUT_OF_STOCK');
  });

  it('rejects stale updates from another device with the fresh bag attached', async () => {
    const c = client(app);
    const sku = await skuWith(10);
    const { cart } = (await c.post(api('/cart/items'), { skuId: sku.id, qty: 1 })).json();
    const line = cart.lines[0];
    await c.request({ method: 'PATCH', url: api(`/cart/items/${line.id}`), payload: { qty: 2, expectedVersion: cart.version } });
    const stale = await c.request({ method: 'PATCH', url: api(`/cart/items/${line.id}`), payload: { qty: 4, expectedVersion: cart.version } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CART_VERSION_CONFLICT');
    expect(stale.json().error.details.cart.lines[0].qty).toBe(2);
  });

  it('flags price changes until acknowledged, and blocks discontinued items', async () => {
    const c = client(app);
    const sku = await skuWith(10);
    await c.post(api('/cart/items'), { skuId: sku.id, qty: 1 });
    await app.ctx.db.update(skus).set({ pricePaise: sku.pricePaise - 50000 }).where(eq(skus.id, sku.id));
    let cart = (await c.get(api('/cart'))).json().cart;
    expect(cart.lines[0].issues).toContainEqual({ type: 'price_changed', blocking: false, fromPaise: sku.pricePaise, toPaise: sku.pricePaise - 50000 });
    expect(cart.totals.subtotalPaise).toBe(sku.pricePaise - 50000); // always the current price
    cart = (await c.post(api('/cart/acknowledge-prices'))).json().cart;
    expect(cart.lines[0].issues).toEqual([]);

    await app.ctx.db.update(skus).set({ status: 'discontinued' }).where(eq(skus.id, sku.id));
    cart = (await c.get(api('/cart'))).json().cart;
    expect(cart.lines[0].issues[0]).toMatchObject({ type: 'unavailable', blocking: true });
    expect(cart.hasBlockingIssues).toBe(true);
    expect(cart.totals.subtotalPaise).toBe(0);
    await app.ctx.db.update(skus).set({ status: 'active', pricePaise: sku.pricePaise }).where(eq(skus.id, sku.id));
  });

  it('moves lines between bag and saved-for-later', async () => {
    const c = client(app);
    const sku = await skuWith(10);
    const { cart } = (await c.post(api('/cart/items'), { skuId: sku.id, qty: 2 })).json();
    const saved = (await c.request({ method: 'PATCH', url: api(`/cart/items/${cart.lines[0].id}`), payload: { savedForLater: true } })).json().cart;
    expect(saved.lines).toHaveLength(0);
    expect(saved.savedForLater[0].qty).toBe(2);
    expect(saved.totals.subtotalPaise).toBe(0);
    const back = (await c.request({ method: 'PATCH', url: api(`/cart/items/${saved.savedForLater[0].id}`), payload: { savedForLater: false } })).json().cart;
    expect(back.lines[0].qty).toBe(2);
    const removed = (await c.delete(api(`/cart/items/${back.lines[0].id}`))).json().cart;
    expect(removed.lines).toHaveLength(0);
  });

  it('merges the guest bag into the account on sign-in using the larger quantity', async () => {
    const user = newUser();
    const a = await skuWith(10);
    const b = await skuWith(10);
    // Account already has 3 × A.
    const account = client(app);
    await account.post(api('/auth/signup'), user);
    await account.post(api('/cart/items'), { skuId: a.id, qty: 3 });
    // Same person browsing as a guest on another device: 1 × A, 2 × B.
    const guest = client(app);
    await guest.post(api('/cart/items'), { skuId: a.id, qty: 1 });
    await guest.post(api('/cart/items'), { skuId: b.id, qty: 2 });
    const signin = await guest.post(api('/auth/signin'), { email: user.email, password: user.password });
    expect(signin.json().mergedBagLines).toBe(2);
    expect(guest.jar.has('avero_cart')).toBe(false);
    const cart = (await guest.get(api('/cart'))).json().cart;
    const qty = Object.fromEntries(cart.lines.map((l: { skuId: string; qty: number }) => [l.skuId, l.qty]));
    expect(qty).toEqual({ [a.id]: 3, [b.id]: 2 });
  });
});

describe('wishlist, recently viewed & alerts', () => {
  it('requires sign-in, then adds, lists, merges and removes', async () => {
    const products = (await client(app).get(api('/products'))).json().items;
    const [first, second, third] = products;
    expect((await client(app).get(api('/wishlist'))).statusCode).toBe(401);

    const c = client(app);
    await c.post(api('/auth/signup'), newUser());
    expect((await c.request({ method: 'PUT', url: api(`/wishlist/${first.colorwayId}`) })).statusCode).toBe(204);
    await c.request({ method: 'PUT', url: api(`/wishlist/${first.colorwayId}`) }); // idempotent
    const merged = (await c.post(api('/wishlist/merge'), { colorwayIds: [first.colorwayId, second.colorwayId, third.colorwayId] })).json();
    expect(merged.added).toBe(2);
    expect(merged.items).toHaveLength(3);
    expect(merged.items.find((i: { colorwayId: string }) => i.colorwayId === first.colorwayId).addedPricePaise).toBe(first.pricePaise);
    await c.delete(api(`/wishlist/${second.colorwayId}`));
    expect((await c.get(api('/wishlist'))).json().items).toHaveLength(2);

    const guestCards = (await client(app).get(api(`/products/by-colorway?ids=${first.colorwayId},not-a-uuid`))).json().items;
    expect(guestCards).toHaveLength(1);
  });

  it('records recently viewed newest first', async () => {
    const products = (await client(app).get(api('/products'))).json().items;
    const c = client(app);
    await c.post(api('/auth/signup'), newUser());
    await c.post(api('/recently-viewed'), { colorwayIds: [products[0].colorwayId] });
    await c.post(api('/recently-viewed'), { colorwayIds: [products[1].colorwayId, products[2].colorwayId] });
    const items = (await c.get(api('/recently-viewed'))).json().items;
    expect(items.map((i: { colorwayId: string }) => i.colorwayId)).toEqual([products[1].colorwayId, products[2].colorwayId, products[0].colorwayId]);
  });

  it('notifies back-in-stock subscribers once when a size returns', async () => {
    const sku = await skuWith(0);
    const c = client(app);
    const user = newUser();
    await c.post(api('/auth/signup'), user);
    expect((await c.post(api('/alerts/stock'), { skuId: sku.id })).json()).toMatchObject({ ok: true, email: user.email });
    expect((await client(app).post(api('/alerts/stock'), { skuId: sku.id })).statusCode).toBe(400); // guest needs an email

    await client(app).post(api(`/dev/skus/${sku.skuCode}`), { onHand: 4 });
    await app.worker.runDue();
    const [mail] = await app.ctx.db.select().from(sentEmails).where(eq(sentEmails.to, user.email)).orderBy(desc(sentEmails.createdAt)).limit(1);
    expect(mail?.subject).toMatch(/^Back in stock/);
    const notes = await app.ctx.db.select().from(notifications).where(eq(notifications.kind, 'stock_alert'));
    expect(notes.length).toBeGreaterThan(0);
    // second restock does not notify again
    await client(app).post(api(`/dev/skus/${sku.skuCode}`), { onHand: 0 });
    await client(app).post(api(`/dev/skus/${sku.skuCode}`), { onHand: 2 });
    await app.worker.runDue();
    const mails = await app.ctx.db.select().from(sentEmails).where(eq(sentEmails.to, user.email));
    expect(mails.filter((m) => m.subject.startsWith('Back in stock'))).toHaveLength(1);
  });
});

describe('account', () => {
  const address = { fullName: 'Riya Sharma', phone: '9876543210', line1: '12 Palm Beach Road', city: 'Navi Mumbai', state: 'Maharashtra', pincode: '400706' };

  it('manages addresses with exactly one default', async () => {
    const c = client(app);
    await c.post(api('/auth/signup'), newUser());
    let list = (await c.post(api('/account/addresses'), address)).json().addresses;
    expect(list[0]).toMatchObject({ isDefault: true, serviceable: true, phone: '+919876543210' });
    list = (await c.post(api('/account/addresses'), { ...address, line1: 'Office', pincode: '744101', isDefault: true })).json().addresses;
    expect(list.map((a: { line1: string; isDefault: boolean; serviceable: boolean }) => [a.line1, a.isDefault, a.serviceable])).toEqual([
      ['Office', true, false],
      ['12 Palm Beach Road', false, true],
    ]);
    list = (await c.delete(api(`/account/addresses/${list[0].id}`))).json().addresses;
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);

    const bad = await c.post(api('/account/addresses'), { ...address, pincode: '12345', state: 'Atlantis' });
    expect(bad.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('updates profile and changes password, signing out other devices', async () => {
    const user = newUser();
    const d1 = client(app);
    const d2 = client(app);
    await d1.post(api('/auth/signup'), user);
    await d2.post(api('/auth/signin'), { email: user.email, password: user.password });
    const profile = await d1.request({ method: 'PATCH', url: api('/account/profile'), payload: { name: 'Riya S', preferredSize: '7', phone: '9123456780' } });
    expect(profile.json().user).toMatchObject({ name: 'Riya S', preferredSize: '7', phone: '+919123456780' });

    const wrong = await d1.post(api('/account/password'), { currentPassword: 'nope', newPassword: 'newpass456' });
    expect(wrong.json().error.code).toBe('VALIDATION_FAILED');
    expect((await d1.post(api('/account/password'), { currentPassword: user.password, newPassword: 'newpass456' })).statusCode).toBe(200);
    expect((await d1.get(api('/auth/me'))).json().user).not.toBeNull();
    expect((await d2.get(api('/auth/me'))).json().user).toBeNull();
  });
});
