import AxeBuilder from '@axe-core/playwright';
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

  test('menu and search overlays pass axe', async ({ page }) => {
    const axe = async (label: string) => {
      const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      expect.soft(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), label).toEqual([]);
    };
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await axe('home');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await axe('menu');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('combobox', { name: 'Search shoes and collections' }).filter({ visible: true }).pressSequentially('sne');
    await expect(page.getByRole('listbox').filter({ visible: true })).toBeVisible();
    await axe('search');
  });

  test('chooses a size, checks out and pays', async ({ page }) => {
    await page.goto(`/p/${PRODUCT}`);
    await page.getByRole('radiogroup', { name: 'Size' }).getByRole('radio', { name: /^Size (?!.*sold out)/ }).first().click();
    await page.getByRole('button', { name: 'Add to bag' }).click();
    // The bag drawer opens once the line is saved.
    await expect(page.getByRole('dialog', { name: /^Your bag \(\d+\)/ })).toBeVisible();
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
