import { expect, test, type Page } from '@playwright/test';
import { advanceOrder, guestDetails, memberOrder, payOnGateway, PRODUCT, signUp } from './helpers';

async function noSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no horizontal page scroll').toBeLessThanOrEqual(0);
}

test.describe('on a phone', () => {
  test('pages fit the screen', async ({ page }) => {
    for (const path of ['/', '/collections/new-arrivals', `/p/${PRODUCT}`, '/bag', '/help', '/help/shipping', '/help/faq', '/track', '/signin', '/signup', '/dev/simulate']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await noSideways(page);
    }
  });

  test('account pages fit the screen', async ({ page }) => {
    await signUp(page, 'Dev Malhotra');
    const orderNumber = await memberOrder(page);
    await advanceOrder(page, orderNumber, 4);
    const order = `/account/orders/${orderNumber}`;
    for (const path of ['/account', '/account/orders', order, '/account/returns', '/account/reviews', '/account/rewards', '/account/referrals', '/account/notifications', '/account/profile', '/account/addresses', '/account/security', '/account/wishlist', '/account/recently-viewed']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await noSideways(page);
    }
    await page.goto(order);
    await page.getByRole('link', { name: 'Return or exchange' }).click();
    await page.getByRole('checkbox').first().check();
    await noSideways(page);
    await page.goto(order);
    await page.getByRole('link', { name: 'Write a review' }).first().click();
    await noSideways(page);
  });

  test('chooses a size, checks out and pays', async ({ page }) => {
    await page.goto(`/p/${PRODUCT}`);
    await page.getByRole('radiogroup', { name: 'Size' }).getByRole('radio', { name: /^Size (?!.*sold out)/ }).first().click();
    await page.getByRole('button', { name: 'Add to bag' }).click();
    await page.goto('/checkout');
    await noSideways(page);
    await guestDetails(page);
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await payOnGateway(page);
    await page.waitForURL(/\/order\/confirmed\//);
    await expect(page.getByRole('heading', { name: 'Thank you — your order is confirmed' })).toBeVisible();
    await noSideways(page);
  });
});
