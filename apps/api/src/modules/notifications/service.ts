import {
  NOTIFICATION_KINDS,
  TRANSACTIONAL_NOTIFICATION_KINDS,
  type NotificationDto,
  type NotificationKind,
  type NotificationListDto,
  type NotificationPreferenceDto,
} from '@avero/shared';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { DbOrTx, Tx } from '../../db/client';
import { notificationPreferences, notifications } from '../../db/schema';
import { enqueue } from '../../jobs/queue';
import type { EmailMessage } from '../../lib/mailer';

export interface NotifyInput {
  /** Null for guests: email only. */
  userId: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  link?: string | null;
  email?: EmailMessage | null;
}

const isTransactional = (kind: NotificationKind) => TRANSACTIONAL_NOTIFICATION_KINDS.includes(kind);

/**
 * The one way to tell a shopper something. Runs inside the caller's transaction: the in-app row and
 * the email job commit (or roll back) with the state change that caused them. Respects per-kind
 * preferences; transactional emails (orders, payments, refunds, returns, account) are always sent.
 */
export async function notify(ctx: AppContext, tx: Tx, input: NotifyInput): Promise<void> {
  let inApp = input.userId !== null;
  let email = Boolean(input.email);
  if (input.userId) {
    const pref = await tx.query.notificationPreferences.findFirst({
      where: and(eq(notificationPreferences.userId, input.userId), eq(notificationPreferences.kind, input.kind)),
    });
    if (pref) {
      inApp = pref.inApp;
      if (!isTransactional(input.kind)) email = email && pref.email;
    }
  }
  if (inApp) {
    await tx.insert(notifications).values({
      userId: input.userId!,
      kind: input.kind,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
      createdAt: ctx.clock.now(),
    });
  }
  if (email && input.email) await enqueue(tx, 'email.send', input.email);
}

const PAGE = 30;

function toDto(n: typeof notifications.$inferSelect): NotificationDto {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    link: n.link,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

export async function unreadCount(db: DbOrTx, userId: string): Promise<number> {
  const [row] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))) as [{ n: number }];
  return row.n;
}

/** Newest first; `cursor` is the createdAt of the last item already shown. */
export async function listNotifications(ctx: AppContext, userId: string, cursor?: string): Promise<NotificationListDto> {
  const rows = await ctx.db.query.notifications.findMany({
    where: and(eq(notifications.userId, userId), cursor ? lt(notifications.createdAt, new Date(cursor)) : undefined),
    orderBy: desc(notifications.createdAt),
    limit: PAGE + 1,
  });
  const page = rows.slice(0, PAGE);
  return {
    notifications: page.map(toDto),
    unreadCount: await unreadCount(ctx.db, userId),
    nextCursor: rows.length > PAGE ? page[page.length - 1]!.createdAt.toISOString() : null,
  };
}

export async function markRead(ctx: AppContext, userId: string, ids: string[] | 'all'): Promise<{ unreadCount: number }> {
  await ctx.db
    .update(notifications)
    .set({ readAt: ctx.clock.now() })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        ids === 'all' ? undefined : inArray(notifications.id, ids),
      ),
    );
  return { unreadCount: await unreadCount(ctx.db, userId) };
}

export async function getPreferences(db: DbOrTx, userId: string): Promise<NotificationPreferenceDto[]> {
  const rows = await db.query.notificationPreferences.findMany({ where: eq(notificationPreferences.userId, userId) });
  const by = new Map(rows.map((r) => [r.kind, r]));
  return NOTIFICATION_KINDS.map((kind) => {
    const locked = isTransactional(kind);
    return { kind, inApp: by.get(kind)?.inApp ?? true, email: locked ? true : (by.get(kind)?.email ?? true), emailLocked: locked };
  });
}

export async function setPreferences(
  ctx: AppContext,
  userId: string,
  prefs: { kind: NotificationKind; inApp: boolean; email: boolean }[],
): Promise<NotificationPreferenceDto[]> {
  await ctx.db.transaction(async (tx) => {
    for (const p of prefs) {
      const email = isTransactional(p.kind) ? true : p.email;
      await tx
        .insert(notificationPreferences)
        .values({ userId, kind: p.kind, inApp: p.inApp, email })
        .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.kind], set: { inApp: p.inApp, email } });
    }
  });
  return getPreferences(ctx.db, userId);
}
