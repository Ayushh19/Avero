import type { PersonalCouponDto, ReferralCodeDto, ReferralDto } from '@avero/shared';
import { and, desc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import type { DbOrTx, Tx } from '../../db/client';
import { couponRedemptions, coupons, pointsLedger, referrals, users } from '../../db/schema';
import { addDays } from '../../lib/clock';
import { randomCode } from '../../lib/crypto';

/**
 * Referrals (docs/BUSINESS_RULES.md 28). A new member who signs up with a code gets a personal
 * coupon (₹250 off a first order ≥ ₹1,999, theirs only). The referrer earns points once that
 * friend's first paid order clears its return window (see loyalty/lifecycle `settleReferral`).
 * No self-referral; the friend's email and phone must both be new to AVERO.
 */

const OFFER_DAYS = 90;

/** Inside the sign-up transaction. Unknown or ineligible codes are ignored (sign-up never fails). */
export async function attachReferral(
  ctx: AppContext,
  tx: Tx,
  referee: { id: string; email: string; phone: string | null },
  code: string | undefined,
): Promise<boolean> {
  if (!code) return false;
  const referrer = await tx.query.users.findFirst({ where: eq(users.referralCode, code.trim().toUpperCase()) });
  if (!referrer || referrer.id === referee.id || referrer.email === referee.email) return false;
  if (referee.phone) {
    const phoneTaken = await tx.query.users.findFirst({ where: and(eq(users.phone, referee.phone), ne(users.id, referee.id)), columns: { id: true } });
    if (phoneTaken) return false;
  }
  await tx.update(users).set({ referredByUserId: referrer.id }).where(eq(users.id, referee.id));
  const [ref] = await tx.insert(referrals).values({ referrerUserId: referrer.id, refereeUserId: referee.id }).onConflictDoNothing().returning();
  if (!ref) return false;

  const now = ctx.clock.now();
  let couponCode = `FRIEND${randomCode(6)}`;
  while (await tx.query.coupons.findFirst({ where: eq(coupons.code, couponCode), columns: { id: true } })) couponCode = `FRIEND${randomCode(6)}`;
  await tx.insert(coupons).values({
    code: couponCode,
    description: `₹${business.referral.refereeDiscountPaise / 100} off your first order — a gift from ${referrer.name.split(' ')[0]}`,
    kind: 'flat',
    value: business.referral.refereeDiscountPaise,
    minOrderPaise: business.referral.refereeMinOrderPaise,
    startsAt: now,
    endsAt: addDays(now, OFFER_DAYS),
    usageLimit: 1,
    perUserLimit: 1,
    firstOrderOnly: true,
    restrictedToUserId: referee.id,
  });
  return true;
}

/** The referee's first paid order becomes the qualifying one (payment-success transaction). */
export async function markQualifyingOrder(tx: Tx, order: { id: string; userId: string | null }): Promise<void> {
  if (!order.userId) return;
  await tx
    .update(referrals)
    .set({ status: 'ordered', qualifyingOrderId: order.id })
    .where(and(eq(referrals.refereeUserId, order.userId), eq(referrals.status, 'signed_up')));
}

/** A qualifying order that was fully cancelled no longer counts: a later order can qualify. */
export async function releaseQualifyingOrder(tx: Tx, orderId: string): Promise<void> {
  await tx
    .update(referrals)
    .set({ status: 'signed_up', qualifyingOrderId: null })
    .where(and(eq(referrals.qualifyingOrderId, orderId), eq(referrals.status, 'ordered')));
}

const firstNameAndInitial = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.at(-1);
  return last ? `${first} ${last[0]!.toUpperCase()}.` : (first ?? 'Friend');
};

export async function referralSummary(ctx: AppContext, userId: string): Promise<ReferralDto> {
  const me = (await ctx.db.query.users.findFirst({ where: eq(users.id, userId) }))!;
  const invites = await ctx.db
    .select({ ref: referrals, name: users.name })
    .from(referrals)
    .innerJoin(users, eq(users.id, referrals.refereeUserId))
    .where(eq(referrals.referrerUserId, userId))
    .orderBy(desc(referrals.createdAt));
  const [{ earned }] = (await ctx.db
    .select({ earned: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)::int` })
    .from(pointsLedger)
    .where(and(eq(pointsLedger.userId, userId), eq(pointsLedger.kind, 'referral')))) as [{ earned: number }];
  return {
    code: me.referralCode,
    link: `${ctx.env.WEB_ORIGIN}/r/${me.referralCode}`,
    offer: {
      refereeDiscountPaise: business.referral.refereeDiscountPaise,
      refereeMinOrderPaise: business.referral.refereeMinOrderPaise,
      referrerRewardPoints: business.referral.referrerRewardPoints,
    },
    invites: invites.map(({ ref, name }) => ({
      name: firstNameAndInitial(name),
      status: ref.status,
      joinedAt: ref.createdAt.toISOString(),
      rewardedAt: ref.rewardedAt?.toISOString() ?? null,
    })),
    pointsEarned: earned,
  };
}

export async function checkReferralCode(ctx: AppContext, code: string): Promise<ReferralCodeDto> {
  const referrer = await ctx.db.query.users.findFirst({ where: eq(users.referralCode, code.trim().toUpperCase()) });
  return {
    valid: Boolean(referrer),
    referrerName: referrer ? referrer.name.split(' ')[0]! : null,
    offer: { refereeDiscountPaise: business.referral.refereeDiscountPaise, refereeMinOrderPaise: business.referral.refereeMinOrderPaise },
  };
}

/** Coupons issued to this member only that they can still use (shown at checkout and in Rewards). */
export async function personalCoupons(db: DbOrTx, userId: string, now: Date): Promise<PersonalCouponDto[]> {
  const rows = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.restrictedToUserId, userId),
        eq(coupons.active, true),
        or(isNull(coupons.endsAt), gt(coupons.endsAt, now)),
        or(isNull(coupons.usageLimit), sql`${coupons.usedCount} < ${coupons.usageLimit}`),
      ),
    );
  const used = rows.length
    ? new Set(
        (await db.select({ id: couponRedemptions.couponId }).from(couponRedemptions).where(and(eq(couponRedemptions.userId, userId), eq(couponRedemptions.status, 'active')))).map(
          (r) => r.id,
        ),
      )
    : new Set<string>();
  return rows.filter((c) => !used.has(c.id)).map((c) => ({ code: c.code, description: c.description, endsAt: c.endsAt?.toISOString() ?? null }));
}
