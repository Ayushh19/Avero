import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_common';

export const jobStatus = pgEnum('job_status', ['pending', 'running', 'done', 'failed']);

/** DB-backed job queue + transactional outbox. See docs/ARCHITECTURE.md. */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    type: text().notNull(),
    payload: jsonb().notNull().default({}),
    runAt: ts().notNull().defaultNow(),
    status: jobStatus().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    dedupeKey: text(),
    lastError: text(),
    lockedAt: ts(),
    completedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index('jobs_due_idx').on(t.runAt).where(sql`${t.status} = 'pending'`),
    uniqueIndex('jobs_dedupe_pending_uq')
      .on(t.dedupeKey)
      .where(sql`${t.status} IN ('pending', 'running')`),
  ],
);

export const idempotencyStatus = pgEnum('idempotency_status', ['in_progress', 'completed']);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    /** Who the key belongs to (user id, guest cart token hash, …) + route. */
    scope: text().notNull(),
    key: text().notNull(),
    requestHash: text().notNull(),
    status: idempotencyStatus().notNull().default('in_progress'),
    responseStatus: integer(),
    responseBody: jsonb(),
    expiresAt: ts().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('idempotency_scope_key_uq').on(t.scope, t.key)],
);

export const sentEmails = pgTable('sent_emails', {
  id: id(),
  to: text().notNull(),
  subject: text().notNull(),
  html: text().notNull(),
  text: text().notNull(),
  template: text(),
  createdAt: createdAt(),
});

export const searchQueries = pgTable(
  'search_queries',
  {
    id: id(),
    query: text().notNull(),
    resultCount: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('search_queries_time_idx').on(t.createdAt)],
);

/** Single-row table: simulated clock offset for dev time travel. */
export const appClock = pgTable('app_clock', {
  id: integer().primaryKey().default(1),
  offsetMs: bigint({ mode: 'number' }).notNull().default(0),
});
