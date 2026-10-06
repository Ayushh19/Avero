import { expect, test } from '@playwright/test';
import { api, guestOrder } from './helpers';

test.describe('simulation panel', () => {
  test('moves the clock forward and back to real time', async ({ page }) => {
    await page.goto('/dev/simulate');
    await expect(page.getByRole('heading', { name: 'Simulation panel' })).toBeVisible();
    const before = await api<{ offsetMs: number }>(page, 'GET', '/dev/clock');

    const clock = page.getByRole('region', { name: 'Simulated clock' });
    await clock.getByRole('button', { name: '+1 day' }).click();
    await expect.poll(async () => (await api<{ offsetMs: number }>(page, 'GET', '/dev/clock')).offsetMs).toBeGreaterThanOrEqual(before.offsetMs + 86_400_000);
    await expect(clock).toContainText('ahead');

    await clock.getByRole('button', { name: 'Reset' }).click();
    await expect(clock).toContainText('real time');
    await expect(clock.getByRole('button', { name: 'Reset' })).toBeDisabled();
  });

  test('advances an order through delivery and shows its emails', async ({ page }) => {
    const { orderNumber, email } = await guestOrder(page);
    await page.goto('/dev/simulate');

    const row = page.getByRole('row').filter({ hasText: orderNumber });
    await expect(row).toContainText('Confirmed');
    for (const status of ['Packed', 'Shipped', 'Out for delivery', 'Delivered']) {
      await row.getByRole('button', { name: 'Advance' }).click();
      await expect(row).toContainText(status);
    }
    await expect(row.getByRole('button', { name: 'Advance' })).toBeDisabled();

    await page.getByRole('tab', { name: 'Emails' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Emails' }).getByText(email).first()).toBeVisible();
  });
});
