import { expect, test } from '@playwright/test';
import { addToBag, advanceOrder, email, memberOrder, memberToReview, openReviews, signUp } from './helpers';

test.describe('engagement', () => {
  test('a friend signs up from an invite link and gets their welcome coupon at checkout', async ({ page, browser }) => {
    const { user: referrer } = await signUp(page, 'Arjun Mehta');

    const friend = await browser.newPage();
    await friend.goto(`/r/${referrer.referralCode}`);
    await expect(friend.getByText('A gift from Arjun')).toBeVisible();
    await expect(friend.getByRole('heading', { name: /₹250 off your first pair/ })).toBeVisible();
    await friend.getByRole('link', { name: 'Create account' }).click();

    await friend.getByLabel('Full name').fill('Neha Kapoor');
    await friend.getByLabel('Email').fill(email('neha'));
    await friend.getByLabel('Mobile number (optional)').fill(`8${String(Date.now()).slice(-9)}`);
    await friend.getByLabel('Password').fill('sneakers123');
    await friend.getByRole('button', { name: 'Create account' }).click();
    await friend.waitForURL((u) => !u.pathname.startsWith('/signup'));

    await addToBag(friend);
    await memberToReview(friend);

    const offer = friend.getByText(/^FRIEND/);
    await expect(offer).toBeVisible();
    const code = (await offer.textContent())!.trim();
    await friend.getByRole('button', { name: 'Apply', exact: true }).first().click();
    const summary = friend.getByRole('complementary', { name: 'Order summary' });
    await expect(summary.getByText(`Coupon ${code}`)).toBeVisible();
    await expect(summary).toContainText('−₹250');
    await friend.close();
  });

  test('a member reviews a delivered pair and it appears on the product page', async ({ page }) => {
    await signUp(page, 'Ishaan Verma');
    const orderNumber = await memberOrder(page);
    await advanceOrder(page, orderNumber, 4);

    await page.goto(`/account/orders/${orderNumber}`);
    await page.getByRole('link', { name: 'Write a review' }).first().click();
    await expect(page.getByRole('heading', { name: 'Write a review' })).toBeVisible();

    // Posting without a rating is refused in the form.
    await page.getByRole('button', { name: 'Post review' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();

    const title = `Comfy from day one ${Date.now().toString(36)}`;
    await page.getByRole('radio', { name: /^4 stars/ }).check({ force: true });
    await page.getByRole('radio', { name: /True to size/ }).check();
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Your review').fill('Wore them on a long walk across the city — no break-in needed and the sole has plenty of grip.');
    await page.getByRole('button', { name: 'Post review' }).click();

    await page.waitForURL(/\/account\/reviews$/);
    await expect(page.getByText('Thanks! Your review is live')).toBeVisible();

    await openReviews(page);
    await page.getByLabel('Sort by').selectOption({ label: 'Most recent' });
    await expect(page.getByText(title)).toBeVisible();
  });

  test('a shopper marks someone else’s review as helpful', async ({ page }) => {
    await signUp(page, 'Tara Nair');
    await openReviews(page);
    const helpful = page.getByRole('button', { name: /^Helpful/ }).first();
    await helpful.scrollIntoViewIfNeeded();
    await expect(helpful).toHaveAttribute('aria-pressed', 'false');
    await helpful.click();
    await expect(helpful).toHaveAttribute('aria-pressed', 'true');
    await openReviews(page);
    await expect(page.getByRole('button', { name: /^Helpful/ }).first()).toHaveAttribute('aria-pressed', 'true');
  });
});
