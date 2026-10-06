import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_common';
import { users } from './identity';
import { orders } from './orders';

export const couponKind = pgEnum('coupon_kind', ['percent', 'flat', 'free_shipping']);

export const coupons = pgTable(
  'coupons',
  {
    id: id(),
    code: text().notNull().unique(),
    description: text().notNull().default(''),
    kind: couponKind().notNull(),
    /** percent: basis points; flat: paise; free_shipping: 0 */
    value: integer().notNull(),
    maxDiscountPaise: integer(),
    minOrderPaise: integer().notNull().default(0),
    startsAt: ts().notNull(),
    endsAt: ts(),
    usageLimit: integer(),
    perUserLimit: integer().notNull().default(1),
    usedCount: integer().notNull().default(0),
    firstOrderOnly: boolean().notNull().default(false),
    eligibleCategoryIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    eligibleCollectionIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** Issued only to a specific user (e.g. referral reward coupons). */
    restrictedToUserId: uuid().references(() => users.id),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'coupons_usage_within_limit',
      sql`${t.usageLimit} IS NULL OR ${t.usedCount} <= ${t.usageLimit}`,
    ),
    check('coupons_used_nonneg', sql`${t.usedCount} >= 0`),
  ],
);

export const couponRedemptionStatus = pgEnum('coupon_redemption_status', ['active', 'released']);

export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: id(),
    couponId: uuid()
      .notNull()
      .references(() => coupons.id),
    orderId: uuid()
      .notNull()
      .unique()
      .references(() => orders.id),
    userId: uuid().references(() => users.id),
    email: text().notNull(),
    status: couponRedemptionStatus().notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [index('coupon_redemptions_coupon_email_idx').on(t.couponId, t.email)],
);

export const pointsKind = pgEnum('points_kind', [
  'earn',
  'redeem',
  'reverse',
  'expire',
  'bonus',
  'referral',
  'refund_credit',
]);
export const pointsStatus = pgEnum('points_status', ['pending', 'available', 'void']);

/** Append-only points ledger. Balance = SUM(delta) WHERE status = 'available'. */
export const pointsLedger = pgTable(
  'points_ledger',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    delta: integer().notNull(),
    kind: pointsKind().notNull(),
    status: pointsStatus().notNull(),
    orderId: uuid().references(() => orders.id),
    note: text(),
    availableAt: ts(),
    expiresAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index('points_ledger_user_idx').on(t.userId, t.status),
    // one earn entry per order
    uniqueIndex('points_ledger_earn_per_order_uq')
      .on(t.orderId, t.kind)
      .where(sql`${t.kind} IN ('earn', 'redeem')`),
  ],
);

export const referralStatus = pgEnum('referral_status', ['signed_up', 'ordered', 'rewarded', 'void']);

export const referrals = pgTable('referrals', {
  id: id(),
  referrerUserId: uuid()
    .notNull()
    .references(() => users.id),
  refereeUserId: uuid()
    .notNull()
    .unique()
    .references(() => users.id),
  status: referralStatus().notNull().default('signed_up'),
  qualifyingOrderId: uuid().references(() => orders.id),
  createdAt: createdAt(),
  rewardedAt: ts(),
});
