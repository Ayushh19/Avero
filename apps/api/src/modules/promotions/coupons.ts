import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { DbOrTx, Tx } from '../../db/client';
import { categories, collectionItems, couponRedemptions, coupons, orders } from '../../db/schema';
import { AppError } from '../../lib/errors';
import type { PricingCoupon } from '../checkout/pricing';

export type CouponRow = typeof coupons.$inferSelect;

export const normalizeCouponCode = (code: string) => code.trim().toUpperCase();

export interface CouponBuyer {
  userId: string | null;
  email: string | null;
}

export interface CouponLineRef {
  skuId: string;
  colorwayId: string;
  categoryId: string;
}

export interface ValidCoupon {
  coupon: CouponRow;
  pricing: PricingCoupon;
  /** SKUs the coupon's category/collection restrictions allow. */
  eligibleSkuIds: Set<string>;
}

/**
 * Checks everything about a coupon that doesn't depend on the bag total (validity window, global
 * and per-buyer limits, first-order-only, restrictions) and works out which lines it covers.
 * Minimum order and "no eligible items" are judged by the pricing engine because they change as the
 * bag changes (they flag the coupon in the quote rather than reject it).
 *
 * Throws the precise COUPON_* error. `excludeOrderId` ignores that order's own redemption.
 */
export async function validateCoupon(
  ctx: AppContext,
  db: DbOrTx,
  rawCode: string,
  buyer: CouponBuyer,
  lines: CouponLineRef[],
  excludeOrderId?: string,
): Promise<ValidCoupon> {
  const code = normalizeCouponCode(rawCode);
  const coupon = await db.query.coupons.findFirst({ where: eq(coupons.code, code) });
  if (!coupon || !coupon.active) throw new AppError('COUPON_NOT_FOUND', `We couldn’t find the code ${code}`);

  const now = ctx.clock.now();
  if (coupon.startsAt > now) throw new AppError('COUPON_NOT_STARTED', `${code} isn’t active yet`);
  if (coupon.endsAt && coupon.endsAt <= now) throw new AppError('COUPON_EXPIRED', `${code} has expired`);
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    throw new AppError('COUPON_LIMIT_REACHED', `${code} has been fully redeemed`);
  }
  if (coupon.restrictedToUserId && coupon.restrictedToUserId !== buyer.userId) {
    throw new AppError('COUPON_NOT_APPLICABLE', `${code} isn’t available on this account`);
  }

  const buyerMatch = buyerCondition(buyer);
  if (buyerMatch) {
    const [{ used }] = (await db
      .select({ used: sql<number>`count(*)::int` })
      .from(couponRedemptions)
      .where(
        and(
          eq(couponRedemptions.couponId, coupon.id),
          eq(couponRedemptions.status, 'active'),
          or(
            buyer.userId ? eq(couponRedemptions.userId, buyer.userId) : undefined,
            buyer.email ? eq(couponRedemptions.email, buyer.email) : undefined,
          ),
          excludeOrderId ? ne(couponRedemptions.orderId, excludeOrderId) : undefined,
        ),
      )) as [{ used: number }];
    if (used >= coupon.perUserLimit) {
      throw new AppError(
        'COUPON_LIMIT_REACHED',
        coupon.perUserLimit === 1 ? `You’ve already used ${code}` : `You’ve used ${code} the maximum ${coupon.perUserLimit} times`,
      );
    }
    if (coupon.firstOrderOnly) {
      const prior = await db
        .select({ id: orders.id })
        .from(orders)
        .where(and(buyerMatch, gt(orders.paidPaise, 0), excludeOrderId ? ne(orders.id, excludeOrderId) : undefined))
        .limit(1);
      if (prior.length) throw new AppError('COUPON_NOT_APPLICABLE', `${code} is for your first order only`);
    }
  }

  return {
    coupon,
    pricing: {
      code,
      kind: coupon.kind,
      value: coupon.value,
      maxDiscountPaise: coupon.maxDiscountPaise,
      minOrderPaise: coupon.minOrderPaise,
    },
    eligibleSkuIds: await eligibleSkus(db, coupon, lines),
  };
}

function buyerCondition(buyer: CouponBuyer) {
  if (!buyer.userId && !buyer.email) return undefined;
  return or(
    buyer.userId ? eq(orders.userId, buyer.userId) : undefined,
    buyer.email ? eq(orders.email, buyer.email) : undefined,
  );
}

/**
 * Category restrictions include sub-categories (e.g. `men` covers `men/running`). Collection
 * restrictions use materialised membership (`collection_items`).
 */
async function eligibleSkus(db: DbOrTx, coupon: CouponRow, lines: CouponLineRef[]): Promise<Set<string>> {
  const all = new Set(lines.map((l) => l.skuId));
  const byCategory = coupon.eligibleCategoryIds.length > 0;
  const byCollection = coupon.eligibleCollectionIds.length > 0;
  if ((!byCategory && !byCollection) || lines.length === 0) return all;

  const eligible = new Set<string>();
  if (byCategory) {
    const ids = [...new Set([...coupon.eligibleCategoryIds, ...lines.map((l) => l.categoryId)])];
    const rows = await db.select({ id: categories.id, path: categories.path }).from(categories).where(inArray(categories.id, ids));
    const pathOf = new Map(rows.map((r) => [r.id, r.path]));
    const allowed = coupon.eligibleCategoryIds.map((id) => pathOf.get(id)).filter((p): p is string => Boolean(p));
    for (const l of lines) {
      const p = pathOf.get(l.categoryId);
      if (p && allowed.some((a) => p === a || p.startsWith(`${a}/`))) eligible.add(l.skuId);
    }
  }
  if (byCollection) {
    const members = await db
      .select({ colorwayId: collectionItems.colorwayId })
      .from(collectionItems)
      .where(
        and(
          inArray(collectionItems.collectionId, coupon.eligibleCollectionIds),
          inArray(collectionItems.colorwayId, lines.map((l) => l.colorwayId)),
        ),
      );
    const inCollection = new Set(members.map((m) => m.colorwayId));
    for (const l of lines) if (inCollection.has(l.colorwayId)) eligible.add(l.skuId);
  }
  return eligible;
}

/**
 * Atomically redeems a coupon for a new order (inside the order transaction). The coupon row is
 * locked so the per-buyer checks and the global counter can't race; the conditional increment and
 * the `used_count <= usage_limit` CHECK are the backstop.
 */
export async function claimCoupon(
  ctx: AppContext,
  tx: Tx,
  rawCode: string,
  order: { id: string; userId: string | null; email: string },
  lines: CouponLineRef[],
): Promise<ValidCoupon> {
  const code = normalizeCouponCode(rawCode);
  await tx.execute(sql`SELECT id FROM coupons WHERE code = ${code} FOR UPDATE`);
  const valid = await validateCoupon(ctx, tx, code, { userId: order.userId, email: order.email }, lines, order.id);
  const claimed = await incrementUsage(tx, valid.coupon.id);
  if (!claimed) throw new AppError('COUPON_LIMIT_REACHED', `${code} has been fully redeemed`);
  await tx.insert(couponRedemptions).values({ couponId: valid.coupon.id, orderId: order.id, userId: order.userId, email: order.email });
  return valid;
}

async function incrementUsage(tx: Tx, couponId: string): Promise<boolean> {
  const rows = await tx
    .update(coupons)
    .set({ usedCount: sql`${coupons.usedCount} + 1` })
    .where(and(eq(coupons.id, couponId), or(isNull(coupons.usageLimit), sql`${coupons.usedCount} < ${coupons.usageLimit}`)))
    .returning({ id: coupons.id });
  return rows.length === 1;
}

/** Releases an order's active redemption (order expired / cancelled). Returns the coupon code, if any. */
export async function releaseCoupon(tx: Tx, orderId: string): Promise<string | null> {
  const [released] = await tx
    .update(couponRedemptions)
    .set({ status: 'released' })
    .where(and(eq(couponRedemptions.orderId, orderId), eq(couponRedemptions.status, 'active')))
    .returning({ couponId: couponRedemptions.couponId });
  if (!released) return null;
  const [c] = await tx
    .update(coupons)
    .set({ usedCount: sql`${coupons.usedCount} - 1` })
    .where(eq(coupons.id, released.couponId))
    .returning({ code: coupons.code });
  return c?.code ?? null;
}

/**
 * Late payment success on an expired order: re-activate its released redemption. The customer has
 * already paid the discounted price, so if the coupon filled up meanwhile the price is honoured and
 * the caller records it; only the global counter is re-checked (window and per-buyer limits were
 * satisfied when the order was placed).
 */
export async function reclaimCoupon(tx: Tx, orderId: string): Promise<'none' | 'reclaimed' | 'over_limit'> {
  const redemption = await tx.query.couponRedemptions.findFirst({ where: eq(couponRedemptions.orderId, orderId) });
  if (!redemption) return 'none';
  if (redemption.status === 'active') return 'reclaimed';
  await tx.execute(sql`SELECT id FROM coupons WHERE id = ${redemption.couponId} FOR UPDATE`);
  if (!(await incrementUsage(tx, redemption.couponId))) return 'over_limit';
  await tx.update(couponRedemptions).set({ status: 'active' }).where(eq(couponRedemptions.id, redemption.id));
  return 'reclaimed';
}
