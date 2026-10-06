import { formatINR, type LoyaltyDto } from '@avero/shared';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import type { DbOrTx, Tx } from '../../db/client';
import { orderItems, orders, pointsLedger, referrals, returnRequests } from '../../db/schema';
import { enqueue } from '../../jobs/queue';
import { addDays } from '../../lib/clock';
import { noticeTemplate } from '../../lib/email-templates';
import { notify } from '../notifications/service';
import { personalCoupons } from '../referrals/service';
import { adjustPendingEarn, pointsBalance } from './points';

/**
 * Points over time (docs/BUSINESS_RULES.md 26–28):
 * - `points.confirm` (at the order's return-window close): pending earn → available, expiring 12
 *   months later; also settles the referral reward if this was the referee's qualifying order.
 * - `points.expire` (at a lot's expiry): expires what's left of due lots, oldest-expiring first.
 *   Lots are consumed by redemptions in that same order (FIFO by expiry), so spent points never
 *   expire. Refund credits never expire (they stand in for money paid).
 */

const EXPIRY_DAYS = 365;
const WARN_DAYS = 30;
type LedgerRow = typeof pointsLedger.$inferSelect;

export const lotExpiry = (availableAt: Date) => addDays(availableAt, EXPIRY_DAYS);

export async function schedulePointsExpiry(tx: Tx, userId: string, at: Date): Promise<void> {
  const key = at.toISOString();
  await enqueue(tx, 'points.expire', { userId }, { runAt: at, dedupeKey: `points-expire:${userId}:${key}` });
  await enqueue(tx, 'points.expiry_warning', { userId, on: key }, { runAt: addDays(at, -WARN_DAYS), dedupeKey: `points-warn:${userId}:${key}` });
}

/** Called when an order is delivered: confirm its points when the return window closes. */
export async function scheduleConfirm(tx: Tx, orderId: string, windowEndsAt: Date): Promise<void> {
  await enqueue(tx, 'points.confirm', { orderId }, { runAt: windowEndsAt, dedupeKey: `points-confirm:${orderId}` });
}

/* ---------------- FIFO lots ---------------- */

const lotMarker = (lotId: string) => `[lot:${lotId}]`;

interface Lot {
  row: LedgerRow;
  /** Points of this lot not yet redeemed or expired. */
  remaining: number;
  expired: boolean;
}

/**
 * Allocates all redemptions to available credit lots, soonest-expiring first (non-expiring last).
 * Lots that already expired keep the amount consumed before they expired.
 */
function allocateLots(rows: LedgerRow[]): Lot[] {
  const available = rows.filter((r) => r.status === 'available');
  const expireRows = available.filter((r) => r.kind === 'expire');
  const expiredBy = new Map<string, number>();
  for (const e of expireRows) {
    const m = /\[lot:([0-9a-f-]+)\]/.exec(e.note ?? '');
    if (m) expiredBy.set(m[1]!, -e.delta);
  }
  let consumed = available.filter((r) => r.delta < 0 && r.kind !== 'expire').reduce((s, r) => s - r.delta, 0);
  const lots = available
    .filter((r) => r.delta > 0)
    .sort((a, b) => {
      const ea = a.expiresAt?.getTime() ?? Infinity;
      const eb = b.expiresAt?.getTime() ?? Infinity;
      return ea - eb || a.createdAt.getTime() - b.createdAt.getTime();
    });
  return lots.map((row) => {
    if (expiredBy.has(row.id)) {
      consumed = Math.max(0, consumed - (row.delta - expiredBy.get(row.id)!));
      return { row, remaining: 0, expired: true };
    }
    const used = Math.min(row.delta, consumed);
    consumed -= used;
    return { row, remaining: row.delta - used, expired: false };
  });
}

async function ledgerFor(db: DbOrTx, userId: string): Promise<LedgerRow[]> {
  return db.query.pointsLedger.findMany({ where: eq(pointsLedger.userId, userId) });
}

/** Job `points.expire`: expire the unused part of every lot that is due, oldest first. */
export async function expireDuePoints(ctx: AppContext, userId: string): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
    const now = ctx.clock.now();
    let total = 0;
    for (const lot of allocateLots(await ledgerFor(tx, userId))) {
      if (lot.expired || !lot.row.expiresAt || lot.row.expiresAt > now || lot.remaining <= 0) continue;
      await tx.insert(pointsLedger).values({
        userId,
        orderId: lot.row.orderId,
        delta: -lot.remaining,
        kind: 'expire',
        status: 'available',
        note: `Expired ${lotMarker(lot.row.id)}`,
        availableAt: now,
        createdAt: now,
      });
      total += lot.remaining;
    }
    if (total > 0) {
      await notify(ctx, tx, { userId, kind: 'points', title: `${total} points expired`, body: 'Points expire 12 months after they become available.', link: '/account/rewards' });
    }
    return total;
  });
}

/** Job `points.expiry_warning`: 30 days before a lot expires, if any of it is still unused. */
export async function warnExpiringPoints(ctx: AppContext, userId: string, on: string): Promise<void> {
  const due = new Date(on);
  const lots = allocateLots(await ledgerFor(ctx.db, userId)).filter((l) => !l.expired && l.row.expiresAt?.getTime() === due.getTime());
  const points = lots.reduce((s, l) => s + l.remaining, 0);
  if (points <= 0) return;
  const date = due.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  await ctx.db.transaction((tx) =>
    notify(ctx, tx, {
      userId,
      kind: 'points',
      title: `${points} points expire on ${date}`,
      body: `Use them at checkout — worth ${formatINR(points * business.points.pointValuePaise)}.`,
      link: '/account/rewards',
    }),
  );
}

/* ---------------- confirm at window close ---------------- */

const KEPT_ITEM = ['DELIVERED', 'EXCHANGED'] as const;

/**
 * Job `points.confirm`. Waits while a return on the order is still in progress (its outcome changes
 * the points), then makes the pending earn available and settles a referral reward.
 */
export async function confirmOrderPoints(ctx: AppContext, orderId: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order?.userId) return;
    const now = ctx.clock.now();
    const open = await tx.query.returnRequests.findFirst({
      where: and(eq(returnRequests.orderId, orderId), notInArray(returnRequests.status, ['COMPLETED', 'CANCELLED'])),
    });
    if (open) {
      await enqueue(tx, 'points.confirm', { orderId }, { runAt: addDays(now, 1) });
      return;
    }

    await adjustPendingEarn(tx, order);
    const [earn] = await tx
      .update(pointsLedger)
      .set({ status: 'available', availableAt: now, expiresAt: lotExpiry(now) })
      .where(and(eq(pointsLedger.orderId, orderId), eq(pointsLedger.kind, 'earn'), eq(pointsLedger.status, 'pending')))
      .returning();
    if (earn) {
      await schedulePointsExpiry(tx, order.userId, lotExpiry(now));
      await notify(ctx, tx, {
        userId: order.userId,
        kind: 'points',
        title: `${earn.delta} points are ready to use`,
        body: `From order ${order.orderNumber} — worth ${formatINR(earn.delta * business.points.pointValuePaise)} at checkout.`,
        link: '/account/rewards',
      });
    }
    await settleReferral(ctx, tx, order);
  });
}

/** The referee's qualifying order cleared its window: reward the referrer, or let a later order qualify. */
async function settleReferral(ctx: AppContext, tx: Tx, order: typeof orders.$inferSelect): Promise<void> {
  const [ref] = await tx.select().from(referrals).where(and(eq(referrals.qualifyingOrderId, order.id), eq(referrals.status, 'ordered'))).for('update');
  if (!ref) return;
  const items = await tx.query.orderItems.findMany({ where: eq(orderItems.orderId, order.id) });
  if (!items.some((i) => (KEPT_ITEM as readonly string[]).includes(i.status))) {
    await tx.update(referrals).set({ status: 'signed_up', qualifyingOrderId: null }).where(eq(referrals.id, ref.id));
    return;
  }
  const now = ctx.clock.now();
  const points = business.referral.referrerRewardPoints;
  await tx.insert(pointsLedger).values({
    userId: ref.referrerUserId,
    delta: points,
    kind: 'referral',
    status: 'available',
    note: 'Referral reward',
    availableAt: now,
    expiresAt: lotExpiry(now),
    createdAt: now,
  });
  await tx.update(referrals).set({ status: 'rewarded', rewardedAt: now }).where(eq(referrals.id, ref.id));
  await schedulePointsExpiry(tx, ref.referrerUserId, lotExpiry(now));
  const referrer = await tx.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, ref.referrerUserId) });
  if (referrer) {
    await notify(ctx, tx, {
      userId: referrer.id,
      kind: 'referral',
      title: `You earned ${points} points`,
      body: 'A friend you invited completed their first order. Thank you for spreading the word!',
      link: '/account/referrals',
      email: noticeTemplate({
        to: referrer.email,
        template: 'referral_reward',
        subject: `You earned ${points} AVERO points`,
        heading: 'Thanks for the referral',
        paragraphs: [`Your friend’s first order is complete, so we’ve added ${points} points (worth ${formatINR(points * business.points.pointValuePaise)}) to your balance.`],
        link: { href: `${ctx.env.WEB_ORIGIN}/account/rewards`, label: 'See your rewards' },
      }),
    });
  }
}

/* ---------------- summary ---------------- */

export async function loyaltySummary(ctx: AppContext, userId: string): Promise<LoyaltyDto> {
  const rows = await ledgerFor(ctx.db, userId);
  const now = ctx.clock.now();
  const horizon = addDays(now, WARN_DAYS);
  const soon = new Map<string, number>();
  for (const lot of allocateLots(rows)) {
    if (lot.expired || lot.remaining <= 0 || !lot.row.expiresAt || lot.row.expiresAt > horizon) continue;
    const day = lot.row.expiresAt.toISOString().slice(0, 10);
    soon.set(day, (soon.get(day) ?? 0) + lot.remaining);
  }
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((x): x is string => Boolean(x)))];
  const numbers = orderIds.length
    ? new Map((await ctx.db.select({ id: orders.id, n: orders.orderNumber }).from(orders).where(inArray(orders.id, orderIds))).map((o) => [o.id, o.n]))
    : new Map<string, string>();
  const visible = rows
    .filter((r) => r.status !== 'void' && r.delta !== 0)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 100);
  return {
    balance: await pointsBalance(ctx.db, userId),
    pending: rows.filter((r) => r.status === 'pending').reduce((s, r) => s + r.delta, 0),
    expiringSoon: [...soon].sort(([a], [b]) => a.localeCompare(b)).map(([on, points]) => ({ points, on })),
    pointValuePaise: business.points.pointValuePaise,
    maxRedeemPercent: business.points.maxRedeemBps / 100,
    ledger: visible.map((r) => ({
      id: r.id,
      delta: r.delta,
      kind: r.kind,
      status: r.status,
      note: r.note?.replace(/\s*\[[a-z]+:[0-9a-f-]+\]$/, '') ?? null,
      orderNumber: r.orderId ? (numbers.get(r.orderId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      availableAt: r.availableAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
    })),
    coupons: await personalCoupons(ctx.db, userId, now),
  };
}

export const _test = { allocateLots };
