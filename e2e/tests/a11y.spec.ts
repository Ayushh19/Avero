import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addToBag, advanceOrder, guestDetails, memberOrder, PRODUCT, signUp } from './helpers';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** Runs axe on the current page (or one region of it) and fails with a readable list of problems. */
async function scan(page: Page, label: string, include?: string) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  const report = violations.map((v) => `[${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join('\n    ')}`);
  expect.soft(report, `accessibility problems on ${label}`).toEqual([]);
}

async function visit(page: Page, path: string) {
  await page.goto(path);
  await scan(page, path);
}

test.describe('accessibility (axe)', () => {
  test('shopping pages', async ({ page }) => {
    for (const path of ['/', '/collections', '/collections/new-arrivals', '/c/men', '/search?q=sneakers', `/p/${PRODUCT}`, '/bag', '/wishlist', '/help', '/help/faq', '/track', '/signin', '/signup', '/forgot-password', '/does-not-exist']) {
      await visit(page, path);
    }
  });

  test('product page tabs and dialogs', async ({ page }) => {
    await page.goto(`/p/${PRODUCT}`);
    await page.getByRole('tab', { name: /^Reviews/ }).click();
    await scan(page, 'product reviews tab');
    await page.getByRole('button', { name: /size guide/i }).click();
    await scan(page, 'size guide dialog', 'dialog[open]');
    await page.keyboard.press('Escape');
    const box = page.getByRole('combobox', { name: 'Search shoes and collections' }).filter({ visible: true });
    await box.click();
    await box.pressSequentially('sne');
    await expect(page.getByRole('listbox').first()).toBeVisible();
    await scan(page, 'search suggestions');
  });

  test('bag drawer and checkout', async ({ page }) => {
    await addToBag(page);
    await page.goto(`/p/${PRODUCT}`);
    await page.getByRole('link', { name: /bag/i }).first().click();
    await scan(page, 'bag');
    await page.goto('/checkout');
    await scan(page, 'checkout: contact');
    await guestDetails(page);
    await scan(page, 'checkout: review');
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await page.waitForURL(/\/checkout\/pay\//);
    await scan(page, 'payment page');
    await page.getByLabel('UPI ID').fill('riya@okhdfc');
    await page.getByRole('radio', { name: 'Declined' }).check();
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await expect(page.getByRole('heading', { name: 'Payment unsuccessful' })).toBeVisible();
    await scan(page, 'payment failed');
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByLabel('UPI ID').fill('riya@okhdfc');
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await page.waitForURL(/\/order\/confirmed\//);
    await scan(page, 'order confirmed');
  });

  test('account pages', async ({ page }) => {
    const { user } = await signUp(page, 'Asha Pillai');
    const orderNumber = await memberOrder(page);
    for (const path of ['/account', '/account/profile', '/account/addresses', '/account/security', '/account/orders', `/account/orders/${orderNumber}`, '/account/notifications', '/account/rewards', '/account/referrals', '/account/wishlist', '/account/recently-viewed']) {
      await visit(page, path);
    }
    await page.goto(`/account/orders/${orderNumber}`);
    await page.getByRole('button', { name: 'Cancel order' }).click();
    await scan(page, 'cancel dialog', 'dialog[open]');
    await page.keyboard.press('Escape');

    await advanceOrder(page, orderNumber, 4);
    await page.goto(`/account/orders/${orderNumber}`);
    await page.getByRole('link', { name: 'Write a review' }).first().click();
    await scan(page, 'review form');
    await visit(page, '/account/reviews');

    await page.goto(`/account/orders/${orderNumber}`);
    await page.getByRole('link', { name: 'Return or exchange' }).click();
    await page.getByRole('checkbox').first().check();
    await scan(page, 'return request');
    await page.getByLabel('Reason').selectOption({ label: 'Too small' });
    await page.getByRole('button', { name: 'Request return' }).click();
    await expect(page.getByRole('heading', { name: /^Return RMA-/ })).toBeVisible();
    await scan(page, 'return detail');
    await visit(page, '/account/returns');

    await page.context().clearCookies();
    await visit(page, `/r/${user.referralCode}`);
  });

  test('simulation panel', async ({ page }) => {
    await visit(page, '/dev/simulate');
    for (const tab of ['Catalogue', 'Customers', 'Emails']) {
      await page.getByRole('tab', { name: tab }).click();
      await scan(page, `simulation: ${tab}`);
    }
  });
});

/** Presses Tab until `target` has focus (fails if it's unreachable), and checks focus is visible. */
async function tabTo(page: Page, target: ReturnType<Page['locator']>, max = 120) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
      const ring = await target.evaluate((el) => {
        const s = getComputedStyle(el);
        return el.matches(':focus-visible') && (s.outlineStyle !== 'none' || s.boxShadow !== 'none');
      });
      expect(ring, 'visible focus indicator').toBe(true);
      return;
    }
  }
  throw new Error(`Could not reach ${target} with the keyboard`);
}

test('checkout can be completed with the keyboard alone', async ({ page }) => {
  await page.goto(`/p/${PRODUCT}`);
  await tabTo(page, page.getByRole('radiogroup', { name: 'Size' }).getByRole('radio', { name: /^Size (?!.*sold out)/ }).first());
  await page.keyboard.press('Space');
  await tabTo(page, page.getByRole('button', { name: 'Add to bag' }));
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: /^Your bag \(\d+\)/ });
  await expect(drawer).toBeVisible();
  await tabTo(page, drawer.getByRole('link', { name: /checkout/i }));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/checkout$/);

  await tabTo(page, page.getByLabel('Email'));
  await page.keyboard.type(`keys.${Date.now()}@example.com`);
  await tabTo(page, page.getByLabel('Mobile number'));
  await page.keyboard.type('9876543210');
  await page.keyboard.press('Enter');

  for (const [label, text] of [
    ['Full name', 'Riya Sharma'],
    ['Mobile number', '9876543210'],
    ['PIN code', '560038'],
    ['City', 'Bengaluru'],
    ['House / flat, building', '12 MG Road'],
  ] as const) {
    await tabTo(page, page.getByLabel(label, { exact: true }));
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(text);
  }
  await tabTo(page, page.getByLabel('State'));
  await page.keyboard.type('Karnataka');
  await expect(page.getByLabel('State')).toHaveValue(/Karnataka/);
  await tabTo(page, page.getByRole('button', { name: 'Deliver here' }));
  await page.keyboard.press('Enter');

  await tabTo(page, page.getByRole('button', { name: 'Continue to review' }));
  await page.keyboard.press('Enter');
  await tabTo(page, page.getByRole('button', { name: /^Pay ₹/ }));
  await page.keyboard.press('Enter');

  await page.waitForURL(/\/checkout\/pay\//);
  await tabTo(page, page.getByLabel('UPI ID'));
  await page.keyboard.type('riya@okhdfc');
  await tabTo(page, page.getByRole('button', { name: /^Pay ₹/ }));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/order\/confirmed\//);
  await expect(page.getByRole('heading', { name: 'Thank you — your order is confirmed' })).toBeVisible();
});
