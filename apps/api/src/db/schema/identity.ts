import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';

export const users = pgTable('users', {
  id: id(),
  email: text().notNull().unique(),
  emailVerifiedAt: ts(),
  passwordHash: text(),
  name: text().notNull(),
  phone: text(),
  preferredSize: text(),
  referralCode: text().notNull().unique(),
  referredByUserId: uuid().references((): AnyPgColumn => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text().notNull().$type<'google'>(),
    providerAccountId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('oauth_provider_account_uq').on(t.provider, t.providerAccountId),
    uniqueIndex('oauth_user_provider_uq').on(t.userId, t.provider),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text().notNull().unique(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts().notNull(),
    lastSeenAt: ts().notNull().defaultNow(),
    userAgent: text(),
    ip: text(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const authTokenPurpose = pgEnum('auth_token_purpose', ['verify_email', 'reset_password']);

export const authTokens = pgTable(
  'auth_tokens',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: authTokenPurpose().notNull(),
    tokenHash: text().notNull().unique(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('auth_tokens_user_idx').on(t.userId, t.purpose)],
);

export const addresses = pgTable(
  'addresses',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fullName: text().notNull(),
    phone: text().notNull(),
    line1: text().notNull(),
    line2: text(),
    landmark: text(),
    city: text().notNull(),
    state: text().notNull(),
    pincode: text().notNull(),
    isDefault: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('addresses_user_idx').on(t.userId),
    uniqueIndex('addresses_one_default_uq').on(t.userId).where(sql`${t.isDefault}`),
  ],
);
