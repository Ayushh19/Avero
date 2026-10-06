import { formatINR, type RefundDto } from '@avero/shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import type { DbOrTx, Tx } from '../../db/client';
import { orderItems, orders, paymentAttempts, refunds } from '../../db/schema';
import { enqueue } from '../../jobs/queue';
import { noticeTemplate } from '../../lib/email-templates';
import { AppError } from '../../lib/errors';
import { transitionItems, transitionRefund, type OrderRow, type RefundRow } from '../../lib/transitions';
import { creditPoints } from '../loyalty/points';
import { notify } from '../notifications/service';
import { orderLink } from '../orders/access';
import * as gateway from '../payments/gateway-sim/service';

/**
 * Refunds (docs/STATE_MACHINES.md §Refund). Money goes back through the simulated gateway by the
 * `refund.process` job: INITIATED → PROCESSING → COMPLETED, or FAILED → retried with backoff;
 * after `business.refundMaxAttempts` failures a member is refunded in AVERO points instead
 * (FALLBACK_TO_POINTS → COMPLETED). Guests have no points, so their refund keeps retrying.
 *
 * Invariant: refunds never exceed what was paid — checked against every refund row for the order
 * under the order row lock, and by `orders_refund_lte_paid` when `refunded_paise` is bumped.
 * `duplicate_capture` refunds return a second capture that never counted towards `paid_paise`.
 */

export type RefundReason = 'cancellation' | 'return' | 'unfulfillable' | 'duplicate_capture';

const pointsFor = (paise: number) => Math.ceil(paise / business.points.pointValuePaise);
const RETRY_BASE_MS = 5 * 60_000;
const GUEST_RETRY_MS = 6 * 60 * 60_000;

export function toRefundDto(r: RefundRow): RefundDto {
  return {
    id: r.id,
    amountPaise: r.amountPaise,
    pointsAmount: r.pointsAmount,
    destination: r.destination,
    status: r.status,
    reason: r.reason,
    attempts: r.attempts,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  };
}

export interface CreateRefundInput {
  /** Must be locked by the caller (SELECT … FOR UPDATE) for the cap check. */
  order: OrderRow;
  amountPaise: number;
  /** Redeemed points to give back (credited immediately, separate from money). */
  pointsToReturn?: number;
  destination: 'original' | 'points';
  reason: RefundReason;
  /** Idempotency: one refund per (order, source). */
  key: string;
  returnRequestId?: string | null;
  paymentAttemptId?: string | null;
}

/**
 * Creates a refund inside the caller's transaction (idempotent by `key`) and starts it:
 * points destination completes immediately; money is handed to the `refund.process` job.
 */
export async function createRefund(ctx: AppContext, tx: Tx, input: CreateRefundInput): Promise<RefundRow> {
  const existing = await tx.query.refunds.findFirst({ where: eq(refunds.idempotencyKey, input.key) });
  if (existing) return existing;
  const { order } = input;

  if (input.reason !== 'duplicate_capture') {
    const [{ committed }] = (await tx
      .select({ committed: sql<number>`coalesce(sum(${refunds.amountPaise}), 0)::int` })
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), ne(refunds.reason, 'duplicate_capture')))) as [{ committed: number }];
    if (committed + input.amountPaise > order.paidPaise) {
      throw new AppError('REFUND_EXCEEDS_PAID', 'This refund would exceed the amount paid', {
        paidPaise: order.paidPaise,
        alreadyRefundedPaise: committed,
        requestedPaise: input.amountPaise,
      });
    }
  }

  const destination = input.destination === 'points' && order.userId ? 'points' : 'original';
  let [refund] = await tx
    .insert(refunds)
    .values({
      orderId: order.id,
      returnRequestId: input.returnRequestId ?? null,
      amountPaise: input.amountPaise,
      pointsAmount: input.pointsToReturn ?? 0,
      destination,
      reason: input.reason,
      idempotencyKey: input.key,
      paymentAttemptId: input.paymentAttemptId ?? null,
      createdAt: ctx.clock.now(),
    })
    .returning();

  if (order.userId && (input.pointsToReturn ?? 0) > 0) {
    await creditPoints(ctx, tx, { userId: order.userId, orderId: order.id, points: input.pointsToReturn!, note: 'Points returned' });
  }

  if (destination === 'points' || input.amountPaise === 0) {
    // Nothing to send to the bank: settle now.
    refund = await transitionRefund(tx, refund!, 'PROCESSING');
    if (input.amountPaise > 0) {
      await creditPoints(ctx, tx, { userId: order.userId!, orderId: order.id, points: pointsFor(input.amountPaise), note: 'Refund as points' });
    }
    return settle(ctx, tx, refund, 'COMPLETED');
  }

  await enqueue(tx, 'refund.process', { refundId: refund!.id }, { dedupeKey: `refund:${refund!.id}` });
  await notify(ctx, tx, {
    userId: order.userId,
    kind: 'refund',
    title: `Refund of ${formatINR(input.amountPaise)} started`,
    body: `For order ${order.orderNumber}. It usually reaches your account in 5–7 business days.`,
    link: order.userId ? `/account/orders/${order.orderNumber}` : null,
  });
  return refund!;
}

/** Final step for every refund: mark completed, count it on the order, tell the shopper. */
async function settle(ctx: AppContext, tx: Tx, refund: RefundRow, via: 'COMPLETED'): Promise<RefundRow> {
  const done = await transitionRefund(tx, refund, via, { completedAt: ctx.clock.now() });
  const [order] = await tx.select().from(orders).where(eq(orders.id, refund.orderId)).for('update');
  if (refund.reason !== 'duplicate_capture' && refund.amountPaise > 0) {
    const [bumped] = await tx
      .update(orders)
      .set({ refundedPaise: sql`${orders.refundedPaise} + ${refund.amountPaise}`, version: sql`${orders.version} + 1` })
      .where(and(eq(orders.id, refund.orderId), sql`${orders.refundedPaise} + ${refund.amountPaise} <= ${orders.paidPaise}`))
      .returning({ id: orders.id });
    if (!bumped) throw new AppError('REFUND_EXCEEDS_PAID', 'Refund would exceed the amount paid');
  }
  if (refund.returnRequestId) {
    const returned = await tx.query.orderItems.findMany({ where: and(eq(orderItems.orderId, refund.orderId), eq(orderItems.status, 'RETURNED')) });
    const ids = await itemsOfReturn(tx, refund.returnRequestId);
    await transitionItems(ctx, tx, refund.orderId, returned.filter((i) => ids.has(i.id)).map((i) => i.id), 'RETURNED', 'REFUNDED', 'item_refunded');
  }
  if (refund.amountPaise > 0 && order) {
    const asPoints = done.destination === 'points';
    const what = asPoints ? `${pointsFor(refund.amountPaise).toLocaleString('en-IN')} AVERO points` : formatINR(refund.amountPaise);
    await notify(ctx, tx, {
      userId: order.userId,
      kind: 'refund',
      title: `Refund completed: ${what}`,
      body: asPoints
        ? `Added to your AVERO Rewards balance for order ${order.orderNumber}.`
        : `Sent to your original payment method for order ${order.orderNumber}.`,
      link: order.userId ? `/account/orders/${order.orderNumber}` : null,
      email: noticeTemplate({
        to: order.email,
        template: 'refund_completed',
        subject: `Refund completed for order ${order.orderNumber}`,
        heading: 'Your refund is complete',
        paragraphs: [
          asPoints
            ? `We’ve added ${what} to your AVERO Rewards balance (1 point = ₹1).`
            : `We’ve refunded ${what} to your original payment method. Depending on your bank, it can take a few days to show.`,
        ],
        link: { href: orderLink(ctx, order), label: 'View your order' },
      }),
    });
  }
  return done;
}

async function itemsOfReturn(db: DbOrTx, returnRequestId: string): Promise<Set<string>> {
  const rows = await db.query.returnItems.findMany({ where: (r, { eq: e }) => e(r.returnRequestId, returnRequestId) });
  return new Set(rows.map((r) => r.orderItemId));
}

/** Which capture to refund: the explicit attempt, else the order's succeeded payment. */
async function captureRef(db: DbOrTx, refund: RefundRow): Promise<string | null> {
  const attempt = refund.paymentAttemptId
    ? await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, refund.paymentAttemptId) })
    : await db.query.paymentAttempts.findFirst({
        where: and(eq(paymentAttempts.orderId, refund.orderId), eq(paymentAttempts.status, 'SUCCEEDED')),
      });
  return attempt?.gatewayRef ?? null;
}

/**
 * Job `refund.process`. Three steps so the gateway call never runs inside a DB transaction:
 * claim (→ PROCESSING, attempt n) · ask the gateway (idempotent per refund+attempt) · apply.
 */
export async function processRefund(ctx: AppContext, refundId: string): Promise<void> {
  const claim = await ctx.db.transaction(async (tx) => {
    const [r] = await tx.select().from(refunds).where(eq(refunds.id, refundId)).for('update');
    if (!r || (r.status !== 'INITIATED' && r.status !== 'FAILED')) return null;
    const gatewayRef = await captureRef(tx, r);
    const claimed = await transitionRefund(tx, r, 'PROCESSING', { attempts: r.attempts + 1 });
    return { refund: claimed, gatewayRef };
  });
  if (!claim) return;

  const result = claim.gatewayRef
    ? await gateway.requestRefund(ctx, {
        requestKey: `${claim.refund.id}:${claim.refund.attempts}`,
        gatewayRef: claim.gatewayRef,
        amountPaise: claim.refund.amountPaise,
      })
    : { status: 'failed' as const, failureReason: 'no_capture_found' };

  await ctx.db.transaction(async (tx) => {
    const [r] = await tx.select().from(refunds).where(eq(refunds.id, refundId)).for('update');
    if (!r || r.status !== 'PROCESSING') return;
    if (result.status === 'succeeded') {
      await settle(ctx, tx, r, 'COMPLETED');
      return;
    }

    const failed = await transitionRefund(tx, r, 'FAILED', { failureReason: result.failureReason });
    const [order] = await tx.select().from(orders).where(eq(orders.id, r.orderId)).for('update');
    const exhausted = failed.attempts >= business.refundMaxAttempts;

    if (exhausted && order?.userId && r.reason !== 'duplicate_capture') {
      const fallback = await transitionRefund(tx, failed, 'FALLBACK_TO_POINTS', { destination: 'points' });
      await creditPoints(ctx, tx, { userId: order.userId, orderId: order.id, points: pointsFor(r.amountPaise), note: 'Refund as points (bank refund failed)' });
      await settle(ctx, tx, fallback, 'COMPLETED');
      return;
    }

    const delay = exhausted ? GUEST_RETRY_MS : RETRY_BASE_MS * 4 ** (failed.attempts - 1);
    await enqueue(tx, 'refund.process', { refundId }, { runAt: new Date(ctx.clock.now().getTime() + delay) });
    if (failed.attempts === 1 && order) {
      await notify(ctx, tx, {
        userId: order.userId,
        kind: 'refund',
        title: 'Your refund is delayed',
        body: `We couldn’t complete the ${formatINR(r.amountPaise)} refund for order ${order.orderNumber} yet. We’re retrying automatically.`,
        link: order.userId ? `/account/orders/${order.orderNumber}` : null,
        email: noticeTemplate({
          to: order.email,
          template: 'refund_delayed',
          subject: `Refund delayed for order ${order.orderNumber}`,
          heading: 'Your refund is delayed',
          paragraphs: [
            `Your bank didn’t accept the ${formatINR(r.amountPaise)} refund on our first try. We’re retrying automatically — you don’t need to do anything.`,
            order.userId ? 'If it keeps failing, we’ll credit the amount as AVERO points instead (1 point = ₹1).' : '',
          ].filter(Boolean),
          link: { href: orderLink(ctx, order), label: 'View your order' },
        }),
      });
    }
  });
}
