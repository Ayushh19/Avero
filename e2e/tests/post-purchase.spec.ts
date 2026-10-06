import { expect, test, type Locator, type Page } from '@playwright/test';
import { advanceOrder, api, guestOrder, memberOrder, signUp } from './helpers';

/** Reloads until the text shows up (background jobs run on the API's worker). */
async function eventually(page: Page, where: (page: Page) => Locator, text: string | RegExp) {
  await expect(async () => {
    await page.reload();
    await expect(where(page)).toContainText(text, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

test.describe('after purchase', () => {
  test('a guest finds their order with Track and cancels it for a refund', async ({ page }) => {
    const { orderNumber, email } = await guestOrder(page);

    await page.goto('/track');
    await page.getByLabel('Order number').fill(orderNumber);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Find order' }).click();
    await expect(page.getByRole('heading', { name: `Order ${orderNumber}` })).toBeVisible();

    await page.getByRole('button', { name: 'Cancel order' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel order' });
    await dialog.getByLabel('Reason').selectOption({ label: 'Changed my mind' });
    await expect(dialog.getByText(/We’ll refund ₹/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel order' }).click();

    await expect(page.getByText('Your order has been cancelled')).toBeVisible();
    const refunds = page.getByRole('region', { name: 'Refunds' });
    await expect(refunds.getByText('to original payment', { exact: false })).toBeVisible();
    await eventually(page, (p) => p.getByRole('region', { name: 'Refunds' }), 'Refunded');
  });

  test('a member returns a delivered pair for AVERO points', async ({ page }) => {
    await signUp(page, 'Kabir Rao');
    const orderNumber = await memberOrder(page);
    await advanceOrder(page, orderNumber, 4);

    await page.goto(`/account/orders/${orderNumber}`);
    await page.getByRole('link', { name: 'Return or exchange' }).click();
    await expect(page.getByRole('heading', { name: 'Return or exchange' })).toBeVisible();

    await page.getByRole('checkbox').first().check();
    await page.getByLabel('Reason').selectOption({ label: 'Too small' });
    await page.getByRole('radio', { name: /AVERO points/ }).check();
    const promised = Number((await page.getByText(/as [\d,]+ points/).textContent())!.replace(/\D/g, ''));
    expect(promised).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Request return' }).click();

    await expect(page.getByRole('heading', { name: /^Return RMA-/ })).toBeVisible();
    const rma = (await page.getByRole('heading', { name: /^Return RMA-/ }).textContent())!.replace('Return ', '').trim();
    for (let i = 0; i < 3; i++) await api(page, 'POST', `/dev/returns/${rma}/advance`);
    await eventually(page, (p) => p.getByRole('region', { name: 'Status' }), 'Completed');

    const loyalty = await api<{ balance: number }>(page, 'GET', '/loyalty');
    expect(loyalty.balance).toBe(promised);
    await page.goto('/account/rewards');
    await expect(page.getByRole('region', { name: 'Points balance' })).toContainText(promised.toLocaleString('en-IN'));
  });

  test('a member exchanges a delivered pair for another size', async ({ page }) => {
    await signUp(page, 'Meera Iyer');
    const orderNumber = await memberOrder(page);
    await advanceOrder(page, orderNumber, 4);

    await page.goto(`/account/orders/${orderNumber}`);
    await page.getByRole('link', { name: 'Return or exchange' }).click();
    await page.getByRole('radio', { name: /^Exchange/ }).check();
    await page.getByRole('checkbox').first().check();
    const swap = page.getByLabel('Exchange for');
    const option = swap.locator('option:not([disabled])').first();
    await swap.selectOption(await option.getAttribute('value'));
    await page.getByLabel('Reason').selectOption({ label: 'Too large' });
    await expect(page.getByText('No charge for the replacement')).toBeVisible();
    await page.getByRole('button', { name: 'Request exchange' }).click();

    await expect(page.getByRole('heading', { name: /^Exchange RMA-/ })).toBeVisible();
  });
});
