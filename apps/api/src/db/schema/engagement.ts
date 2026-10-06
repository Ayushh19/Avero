import { NOTIFICATION_KINDS } from '@avero/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { colorways, products } from './catalog';
import { users } from './identity';
import { orderItems } from './orders';

export const reviewFit = pgEnum('review_fit', ['small', 'true', 'large']);
export const reviewStatus = pgEnum('review_status', ['published', 'hidden']);

export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    colorwayId: uuid()
      .notNull()
      .references(() => colorways.id),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orderItemId: uuid()
      .notNull()
      .references(() => orderItems.id),
    rating: integer().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    fit: reviewFit(),
    sizePurchased: text().notNull(),
    helpfulCount: integer().notNull().default(0),
    status: reviewStatus().notNull().default('published'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reviews_user_product_uq').on(t.userId, t.productId),
    index('reviews_product_idx').on(t.productId, t.createdAt),
    check('reviews_rating_range', sql`${t.rating} BETWEEN 1 AND 5`),
  ],
);

export const reviewVotes = pgTable(
  'review_votes',
  {
    reviewId: uuid()
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.reviewId, t.userId] })],
);

export { NOTIFICATION_KINDS } from '@avero/shared';
export const notificationKind = pgEnum('notification_kind', NOTIFICATION_KINDS);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationKind().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    link: text(),
    readAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationKind().notNull(),
    inApp: boolean().notNull().default(true),
    email: boolean().notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);
