import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { DbOrTx, Tx } from '../../db/client';
import { orderItems, pointsLedger } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { pointsForPaid } from '../checkout/pricing';

/**
 * Points ledger (append-only rows; `status` moves pending → available → void).
 * Balance = SUM(delta) of `available` rows. A redemption is a negative `available` row; reversing
 * it flips that row to `void`, which restores the balance and keeps one redeem row per order.
 *
 * Phase 3 scope: redeem at checkout, reverse on expiry, record pending earn on payment success.
 * Pending → available (after the return window) is Phase 5; voiding on cancel/return is Phase 4.
 */

export async function pointsBalance(db: DbOrTx, userId: string): Promise<number> {
  const [row] = (await db
    .select({ balance: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)::int` })
    .from(pointsLedger)
    .where(and(eq(pointsLedger.userId, userId), eq(pointsLedger.status, 'available')))) as [{ balance: number }];
  return row.balance;
}

/** Serialises balance checks per user for the rest of the transaction. */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
}

/** Inside the place-order transaction. */
export async function redeemPoints(ctx: AppContext, tx: Tx, userId: string, orderId: string, points: number): Promise<void> {
  if (points <= 0) return;
  await lockUser(tx, userId);
  const balance = await pointsBalance(tx, userId);
  if (balance < points) {
    throw new AppError('POINTS_INSUFFICIENT', `You have ${balance} points available`, { balance });
  }
  await tx.insert(pointsLedger).values({
    userId,
    orderId,
    delta: -points,
    kind: 'redeem',
    status: 'available',
    note: 'Redeemed at checkout',
    availableAt: ctx.clock.now(),
  });
}

/** Order expired (or will never be fulfilled): give the redeemed points back. Returns points restored. */
export async function reversePoints(tx: Tx, orderId: string): Promise<number> {
  const [row] = await tx
    .update(pointsLedger)
    .set({ status: 'void' })
    .where(and(eq(pointsLedger.orderId, orderId), eq(pointsLedger.kind, 'redeem'), eq(pointsLedger.status, 'available')))
    .returning({ delta: pointsLedger.delta });
  return row ? -row.delta : 0;
}

/**
 * Late payment success on an expired order: take the redeemed points again. If the shopper spent
 * them meanwhile, the price they paid is honoured and the caller records it.
 */
export async function reclaimPoints(tx: Tx, orderId: string): Promise<'none' | 'reclaimed' | 'insufficient'> {
  const row = await tx.query.pointsLedger.findFirst({
    where: and(eq(pointsLedger.orderId, orderId), eq(pointsLedger.kind, 'redeem')),
  });
  if (!row) return 'none';
  if (row.status === 'available') return 'reclaimed';
  await lockUser(tx, row.userId);
  if ((await pointsBalance(tx, row.userId)) < -row.delta) return 'insufficient';
  await tx.update(pointsLedger).set({ status: 'available' }).where(eq(pointsLedger.id, row.id));
  return 'reclaimed';
}

/**
 * Payment succeeded: record the (pending) points this order earns — 1 per ₹100 actually paid,
 * excluding shipping, so redeemed points earn nothing. One earn row per order (unique index).
 */
export async function recordEarn(
  tx: Tx,
  order: { id: string; userId: string | null; paidPaise: number; shippingPaise: number },
): Promise<number> {
  if (!order.userId) return 0;
  const points = pointsForPaid(order.paidPaise - order.shippingPaise);
  if (points <= 0) return 0;
  const inserted = await tx
    .insert(pointsLedger)
    .values({ userId: order.userId, orderId: order.id, delta: points, kind: 'earn', status: 'pending', note: 'Earned on order' })
    .onConflictDoNothing()
    .returning({ id: pointsLedger.id });
  return inserted.length ? points : 0;
}

/** Credits available points straight away (refund paid as points, points returned on cancel/return). */
export async function creditPoints(
  ctx: AppContext,
  tx: Tx,
  input: { userId: string; orderId: string; points: number; note: string },
): Promise<void> {
  if (input.points <= 0) return;
  await tx.insert(pointsLedger).values({
    userId: input.userId,
    orderId: input.orderId,
    delta: input.points,
    kind: 'refund_credit',
    status: 'available',
    note: input.note,
    availableAt: ctx.clock.now(),
  });
}

/** Item statuses whose paid amount the customer keeps (and so still earns points on). */
const KEPT = ['ACTIVE', 'DELIVERED', 'RETURN_REQUESTED', 'EXCHANGE_REQUESTED', 'EXCHANGED'] as const;

/**
 * Cancellation / return: shrink the order's *pending* earn to what the customer keeps, voiding it
 * when nothing is left. Points already available are never clawed back here (Phase 5 concern).
 */
export async function adjustPendingEarn(tx: Tx, order: { id: string; userId: string | null }): Promise<void> {
  if (!order.userId) return;
  const earn = await tx.query.pointsLedger.findFirst({
    where: and(eq(pointsLedger.orderId, order.id), eq(pointsLedger.kind, 'earn'), eq(pointsLedger.status, 'pending')),
  });
  if (!earn) return;
  const items = await tx.query.orderItems.findMany({ where: eq(orderItems.orderId, order.id) });
  const kept = items.filter((i) => (KEPT as readonly string[]).includes(i.status)).reduce((s, i) => s + i.totalPaise, 0);
  const points = pointsForPaid(kept);
  if (points === earn.delta) return;
  await tx
    .update(pointsLedger)
    .set(points > 0 ? { delta: points } : { status: 'void' })
    .where(eq(pointsLedger.id, earn.id));
}
