import { expect, type Page } from '@playwright/test';

export const PRODUCT = 'mens-gray-low-top-sneakers';

let seq = 0;
/** Unique per run, so journeys never collide in the shared in-memory world. */
export const uid = () => `${Date.now().toString(36)}${(++seq).toString(36)}`;
export const email = (name: string) => `${name}.${uid()}@example.com`;

/** Calls the API from the page (shares its cookies: bag, session, guest device). */
export async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  return page.evaluate(
    async ([m, p, b, k]) => {
      const headers: Record<string, string> = { 'X-Requested-With': 'avero', 'content-type': 'application/json' };
      if (k) headers['Idempotency-Key'] = k;
      const res = await fetch(`/api/v1${p}`, { method: m, headers, body: b ? JSON.stringify(b) : m === 'GET' ? undefined : '{}' });
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as T;
    },
    [method, path, body, idempotencyKey] as const,
  );
}

/** Adds a purchasable size of a product to the bag (restocking it so journeys never run dry). */
export async function addToBag(page: Page, slug = PRODUCT): Promise<{ skuId: string; skuCode: string }> {
  if (!page.url().startsWith('http')) await page.goto('/');
  const pdp = await api<{ product: { colorways: { skus: { id: string; state: string }[] }[] } }>(page, 'GET', `/products/${slug}`);
  const sku = pdp.product.colorways.flatMap((c) => c.skus).find((s) => s.state !== 'unavailable');
  expect(sku, 'a purchasable size').toBeTruthy();
  const { cart } = await api<{ cart: { lines: { skuId: string; skuCode: string }[] } }>(page, 'POST', '/cart/items', { skuId: sku!.id, qty: 1 });
  const line = cart.lines.find((l) => l.skuId === sku!.id)!;
  await api(page, 'POST', `/dev/skus/${line.skuCode}`, { onHand: 40 });
  return { skuId: sku!.id, skuCode: line.skuCode };
}

/** Guest checkout up to the review step. */
export async function guestDetails(page: Page, address: { pincode?: string; city?: string; state?: string } = {}, contact = email('guest')) {
  await page.getByLabel('Email').fill(contact);
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await fillAddress(page, address);
  await page.getByRole('button', { name: 'Continue to review' }).click();
}

export async function fillAddress(page: Page, address: { pincode?: string; city?: string; state?: string } = {}) {
  await page.getByLabel('Full name').fill('Riya Sharma');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByLabel('PIN code').fill(address.pincode ?? '560038');
  await page.getByLabel('City').fill(address.city ?? 'Bengaluru');
  await page.getByLabel('House / flat, building').fill('12 MG Road, Indiranagar');
  await page.getByLabel('State').selectOption(address.state ?? 'Karnataka');
  await page.getByRole('button', { name: 'Deliver here' }).click();
}

/** On the simulated gateway: UPI, pick the outcome, pay. */
export async function payOnGateway(page: Page, scenario: RegExp | string = 'Payment succeeds', extra?: () => Promise<void>) {
  await page.waitForURL(/\/checkout\/pay\//);
  await page.getByLabel('UPI ID').fill('riya@okhdfc');
  await page.getByRole('radio', { name: scenario }).check();
  if (extra) await extra();
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
}

/** Bag → checkout → pay successfully as a guest; returns the order number and email. */
export async function guestOrder(page: Page): Promise<{ orderNumber: string; email: string }> {
  const contact = email('guest');
  await addToBag(page);
  await page.goto('/checkout');
  await guestDetails(page, {}, contact);
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await payOnGateway(page);
  await page.waitForURL(/\/order\/confirmed\//);
  return { orderNumber: page.url().split('/').pop()!, email: contact };
}

export async function signUp(page: Page, name = 'Riya Sharma', opts: { phone?: string } = {}) {
  if (!page.url().startsWith('http')) await page.goto('/');
  const address = email(name.split(' ')[0]!.toLowerCase());
  const phone = opts.phone ?? `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  const res = await api<{ user: { id: string; referralCode: string } }>(page, 'POST', '/auth/signup', { name, email: address, password: 'sneakers123', phone });
  expect(res.user, 'signed up').toBeTruthy();
  await page.reload();
  return { email: address, user: res.user };
}

export async function advanceOrder(page: Page, orderNumber: string, steps: number) {
  for (let i = 0; i < steps; i++) await api(page, 'POST', `/dev/orders/${orderNumber}/advance`);
}

export const key = () => `e2e-${uid()}`;

/** Signed-in checkout up to the review step (the contact step is skipped when a phone is on file). */
export async function memberToReview(page: Page) {
  await page.goto('/checkout');
  const contact = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(contact.or(page.getByLabel('Full name'))).toBeVisible();
  if (await contact.isVisible()) {
    await page.getByLabel('Mobile number').fill('9876543210');
    await contact.click();
  }
  await fillAddress(page);
  await page.getByRole('button', { name: 'Continue to review' }).click();
}

/** Signed-in purchase that pays successfully; returns the order number. */
export async function memberOrder(page: Page): Promise<string> {
  await addToBag(page);
  await memberToReview(page);
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await payOnGateway(page);
  await page.waitForURL(/\/order\/confirmed\//);
  return page.url().split('/').pop()!;
}

/** Product page with the Reviews tab open. */
export async function openReviews(page: Page, slug = PRODUCT) {
  await page.goto(`/p/${slug}`);
  await page.getByRole('tab', { name: /^Reviews/ }).click();
}

export async function advanceClock(page: Page, minutes: number) {
  await api(page, 'POST', '/dev/clock/advance', { minutes });
}
