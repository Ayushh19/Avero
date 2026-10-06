import { expect, test } from '@playwright/test';
import { addToBag, guestDetails, payOnGateway } from './helpers';

test.describe('guest checkout', () => {
  test('pays with a coupon and lands on the confirmation', async ({ page }) => {
    await addToBag(page);
    await page.goto('/checkout');
    await guestDetails(page);

    await page.getByLabel('Coupon code').fill('WELCOME10');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    const summary = page.getByRole('complementary', { name: 'Order summary' });
    await expect(summary.getByText('Coupon WELCOME10')).toBeVisible();

    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await payOnGateway(page);
    await page.waitForURL(/\/order\/confirmed\//);
    await expect(page.getByRole('heading', { name: 'Thank you — your order is confirmed' })).toBeVisible();
    // The bag was emptied by the successful payment.
    await page.goto('/bag');
    await expect(page.getByRole('heading', { name: 'Your bag is empty' })).toBeVisible();
  });

  test('a declined payment can be retried and then succeeds', async ({ page }) => {
    await addToBag(page);
    await page.goto('/checkout');
    await guestDetails(page);
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await payOnGateway(page, 'Declined');

    await expect(page.getByRole('heading', { name: 'Payment unsuccessful' })).toBeVisible();
    await expect(page.getByText('No money was taken.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Try again' }).click();
    await payOnGateway(page);
    await page.waitForURL(/\/order\/confirmed\//);
  });

  test('a pending payment resolves once the bank decides', async ({ page }) => {
    await addToBag(page);
    await page.goto('/checkout');
    await guestDetails(page);
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await payOnGateway(page, /^Pending/, async () => {
      await page.getByRole('radio', { name: 'Then approved' }).check();
    });

    await expect(page.getByRole('heading', { name: 'Your bank is still processing' })).toBeVisible();
    // The bank answers after ~30 simulated seconds; move the clock instead of waiting.
    await page.evaluate(() =>
      fetch('/api/v1/dev/clock/advance', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Requested-With': 'avero' }, body: JSON.stringify({ minutes: 1 }) }),
    );
    await page.waitForURL(/\/order\/confirmed\//, { timeout: 20_000 });
  });

  test('cancelling on the gateway keeps the items reserved', async ({ page }) => {
    await addToBag(page);
    await page.goto('/checkout');
    await guestDetails(page);
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await page.waitForURL(/\/checkout\/pay\//);
    await page.getByRole('button', { name: 'Cancel payment' }).click();

    await expect(page.getByRole('heading', { name: 'Payment cancelled' })).toBeVisible();
    await expect(page.getByText(/Your items are reserved for/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('rejects an invalid UPI ID on the gateway', async ({ page }) => {
    await addToBag(page);
    await page.goto('/checkout');
    await guestDetails(page);
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await page.waitForURL(/\/checkout\/pay\//);
    await page.getByLabel('UPI ID').fill('not-a-vpa');
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await expect(page.getByText('Enter a UPI ID like name@okhdfc')).toBeVisible();
    await expect(page).toHaveURL(/\/checkout\/pay\//);
  });
});
