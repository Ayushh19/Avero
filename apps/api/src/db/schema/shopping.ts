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
import { createdAt, id, ts, updatedAt } from './_common';
import { colorways, skus } from './catalog';
import { users } from './identity';

export const cartStatus = pgEnum('cart_status', ['active', 'merged', 'converted']);

export const carts = pgTable(
  'carts',
  {
    id: id(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    guestTokenHash: text(),
    status: cartStatus().notNull().default('active'),
    /** Bumped on every mutation; used for optimistic concurrency across devices. */
    version: integer().notNull().default(1),
    couponCode: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('carts_active_user_uq').on(t.userId).where(sql`${t.status} = 'active'`),
    uniqueIndex('carts_guest_token_uq').on(t.guestTokenHash),
    check(
      'carts_owner_xor',
      sql`(${t.userId} IS NULL) <> (${t.guestTokenHash} IS NULL)`,
    ),
  ],
);

export const cartItems = pgTable(
  'cart_items',
  {
    id: id(),
    cartId: uuid()
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    skuId: uuid()
      .notNull()
      .references(() => skus.id),
    qty: integer().notNull(),
    savedForLater: boolean().notNull().default(false),
    /** Price the shopper last saw, to surface "price changed" in the bag. */
    priceSeenPaise: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('cart_items_cart_sku_uq').on(t.cartId, t.skuId, t.savedForLater),
    check('cart_items_qty_positive', sql`${t.qty} > 0`),
  ],
);

export const wishlistItems = pgTable(
  'wishlist_items',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    colorwayId: uuid()
      .notNull()
      .references(() => colorways.id, { onDelete: 'cascade' }),
    skuId: uuid().references(() => skus.id, { onDelete: 'set null' }),
    /** Lowest price when added; powers "price dropped" in the wishlist. */
    addedPricePaise: integer(),
    /** Lowest price we last sent a price-drop alert for (alerts fire only on a new low). */
    priceAlertedPaise: integer(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('wishlist_user_colorway_uq').on(t.userId, t.colorwayId)],
);

export const recentlyViewed = pgTable(
  'recently_viewed',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    colorwayId: uuid()
      .notNull()
      .references(() => colorways.id, { onDelete: 'cascade' }),
    viewedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recently_viewed_user_colorway_uq').on(t.userId, t.colorwayId),
    index('recently_viewed_user_time_idx').on(t.userId, t.viewedAt),
  ],
);

export const stockAlertKind = pgEnum('stock_alert_kind', ['back_in_stock', 'price_drop']);

export const stockAlerts = pgTable(
  'stock_alerts',
  {
    id: id(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    kind: stockAlertKind().notNull(),
    skuId: uuid().references(() => skus.id, { onDelete: 'cascade' }),
    colorwayId: uuid()
      .notNull()
      .references(() => colorways.id, { onDelete: 'cascade' }),
    baselinePricePaise: integer(),
    notifiedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('stock_alerts_pending_idx').on(t.colorwayId, t.kind).where(sql`${t.notifiedAt} IS NULL`)],
);
