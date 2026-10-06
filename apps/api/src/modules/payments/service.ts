import type { PaymentAttemptStatusDto, PaymentMethod } from '@avero/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import type { Tx } from '../../db/client';
import { orders, paymentAttempts, paymentEvents } from '../../db/schema';
import { enqueue } from '../../jobs/queue';
import { addMinutes } from '../../lib/clock';
import { hmacSha256, safeEqual } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { recordOrderEvent, transitionAttempt, transitionOrder, type AttemptRow, type OrderRow } from '../../lib/transitions';
import { canAccessOrder } from '../orders/access';
import { expireOrder, isLiveUnpaid, lockOrder, onPaymentNotCompleted, onPaymentSucceeded } from '../orders/lifecycle';
import { canPay, latestAttempt, toAttemptDto } from '../orders/service';
import { createRefund } from '../refunds/service';
import * as gateway from './gateway-sim/service';

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const;
const isTerminal = (s: AttemptRow['status']) => (TERMINAL as readonly string[]).includes(s);

/* ---------------- attempts ---------------- */

/**
 * Starts a payment for an order awaiting payment (or retrying after a failure, while its
 * reservation is alive). Called under `withIdempotency`; `idempotencyKey` is also stored on the row
 * (unique) as a database-level backstop.
 */
export async function createAttempt(
  ctx: AppContext,
  req: FastifyRequest,
  input: { orderNumber: string; method: PaymentMethod },
  idempotencyKey: string,
): Promise<AttemptRow> {
  const found = await ctx.db.query.orders.findFirst({ where: eq(orders.orderNumber, input.orderNumber.toUpperCase()) });
  if (!found || !canAccessOrder(ctx, req, found)) throw new AppError('NOT_FOUND', 'Order not found');

  return ctx.db.transaction(async (tx) => {
    let order = (await lockOrder(tx, found.id))!;
    const now = ctx.clock.now();
    if (!isLiveUnpaid(order.status) || !order.reservationExpiresAt || order.reservationExpiresAt <= now) {
      throw new AppError('ORDER_NOT_PAYABLE', notPayableMessage(order), { status: order.status });
    }

    // At most one attempt in flight. An attempt that was opened but never submitted at the
    // gateway (shopper went back to switch method) is cancelled and replaced.
    const open = await tx
      .select()
      .from(paymentAttempts)
      .where(and(eq(paymentAttempts.orderId, order.id), inArray(paymentAttempts.status, ['CREATED', 'PENDING'])))
      .for('update');
    for (const a of open) {
      if (a.status === 'PENDING' || !(await gateway.voidCharge(ctx, tx, a.gatewayRef))) {
        throw new AppError('PAYMENT_IN_PROGRESS', 'A payment for this order is already being processed', { attemptId: a.id });
      }
      await transitionAttempt(ctx, tx, a, 'CANCELLED', { failureReason: 'superseded' });
    }

    if (order.status === 'PAYMENT_FAILED') {
      order = await transitionOrder(ctx, tx, order, 'PENDING_PAYMENT', { event: 'payment_retry', meta: { method: input.method } });
    }

    const ttl = addMinutes(now, business.payments.attemptTtlMinutes);
    const expiresAt = ttl < order.reservationExpiresAt! ? ttl : order.reservationExpiresAt!;
    const attemptId = uuidv7();
    const gatewayRef = await gateway.createCharge(ctx, tx, {
      merchantReference: attemptId,
      amountPaise: order.totalPaise,
      method: input.method,
      expiresAt,
      lateAfter: order.reservationExpiresAt,
    });
    const [attempt] = await tx
      .insert(paymentAttempts)
      .values({ id: attemptId, orderId: order.id, amountPaise: order.totalPaise, method: input.method, gatewayRef, idempotencyKey, expiresAt })
      .returning();
    await recordOrderEvent(ctx, tx, order.id, 'payment_started', { attemptId: attempt!.id, method: input.method });
    await enqueue(
      tx,
      'payment.reconcile',
      { attemptId: attempt!.id },
      { runAt: new Date(expiresAt.getTime() + business.payments.reconcileGraceSeconds * 1000), dedupeKey: `reconcile:${attempt!.id}` },
    );
    return attempt!;
  });
}

function notPayableMessage(order: OrderRow): string {
  switch (order.status) {
    case 'EXPIRED':
      return 'This order expired before payment. Your bag is still saved — please check out again.';
    case 'PENDING_PAYMENT':
    case 'PAYMENT_FAILED':
      return 'The time to pay for this order has run out. Your bag is still saved — please check out again.';
    default:
      return 'This order has already been paid';
  }
}

export async function attemptStatus(ctx: AppContext, req: FastifyRequest, attemptId: string): Promise<PaymentAttemptStatusDto> {
  const attempt = await ctx.db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId) });
  const order = attempt && (await ctx.db.query.orders.findFirst({ where: eq(orders.id, attempt.orderId) }));
  if (!attempt || !order || !canAccessOrder(ctx, req, order)) throw new AppError('NOT_FOUND', 'Payment not found');
  const latest = await latestAttempt(ctx.db, order.id);
  return {
    attempt: toAttemptDto(attempt, order.orderNumber),
    order: {
      orderNumber: order.orderNumber,
      status: order.status,
      reservationExpiresAt: order.reservationExpiresAt?.toISOString() ?? null,
      canPay: canPay(ctx, order, latest),
    },
  };
}

/* ---------------- outcomes ---------------- */

type Outcome =
  | { type: 'pending' }
  | { type: 'succeeded' }
  | { type: 'failed' | 'cancelled' | 'expired'; reason: string | null };

type Source = 'webhook' | 'reconcile';

export interface ApplyResult {
  stockChanged: boolean;
  /** Reconciliation found a late success; it must come through the webhook (see transitionOrder). */
  needsWebhook: boolean;
  ignored?: string;
}

/**
 * Applies a gateway outcome to an attempt and its order. Runs in the caller's transaction with both
 * rows locked. Terminal attempt states never change; out-of-order or repeated outcomes are
 * recorded as order events and otherwise ignored.
 */
async function applyOutcome(ctx: AppContext, tx: Tx, attempt: AttemptRow, order: OrderRow, outcome: Outcome, source: Source): Promise<ApplyResult> {
  const ignore = async (why: string): Promise<ApplyResult> => {
    await recordOrderEvent(ctx, tx, order.id, 'payment_event_ignored', { attemptId: attempt.id, outcome: outcome.type, attemptStatus: attempt.status, why, source });
    return { stockChanged: false, needsWebhook: false, ignored: why };
  };

  if (isTerminal(attempt.status)) {
    return attempt.status === 'SUCCEEDED' && outcome.type === 'succeeded'
      ? { stockChanged: false, needsWebhook: false, ignored: 'already_succeeded' }
      : ignore('attempt_already_terminal');
  }

  switch (outcome.type) {
    case 'pending':
      if (attempt.status === 'CREATED') await transitionAttempt(ctx, tx, attempt, 'PENDING');
      return { stockChanged: false, needsWebhook: false };

    case 'succeeded': {
      if (order.status === 'EXPIRED' && source !== 'webhook') return { stockChanged: false, needsWebhook: true };
      if (!isLiveUnpaid(order.status) && order.status !== 'EXPIRED') {
        // Another attempt already paid this order: the gateway captured twice. Never mark a second
        // success (unique index); record it and refund the extra capture.
        await createRefund(ctx, tx, {
          order,
          amountPaise: attempt.amountPaise,
          destination: 'original',
          reason: 'duplicate_capture',
          key: `duplicate-capture:${attempt.id}`,
          paymentAttemptId: attempt.id,
        });
        await transitionAttempt(ctx, tx, attempt, 'CANCELLED', { failureReason: 'duplicate_capture_refunded' });
        return ignore('order_already_paid');
      }
      const succeeded = await transitionAttempt(ctx, tx, attempt, 'SUCCEEDED');
      await onPaymentSucceeded(ctx, tx, order, succeeded);
      return { stockChanged: true, needsWebhook: false };
    }

    default: {
      const to = outcome.type === 'failed' ? 'FAILED' : outcome.type === 'cancelled' ? 'CANCELLED' : 'EXPIRED';
      const ended = await transitionAttempt(ctx, tx, attempt, to, { failureReason: outcome.reason });
      await onPaymentNotCompleted(ctx, tx, order, ended);
      return { stockChanged: false, needsWebhook: false };
    }
  }
}

/** Locks attempt then order (always this order, to avoid deadlocks). */
async function lockAttemptAndOrder(tx: Tx, attemptId: string): Promise<{ attempt: AttemptRow; order: OrderRow } | null> {
  const [attempt] = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId)).for('update');
  if (!attempt) return null;
  const order = await lockOrder(tx, attempt.orderId);
  return order ? { attempt, order } : null;
}

/* ---------------- webhook ---------------- */

const webhookEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(['payment.pending', 'payment.succeeded', 'payment.failed', 'payment.cancelled']),
  createdAt: z.string(),
  data: z.object({
    gatewayRef: z.string().min(1),
    merchantReference: z.string().optional(),
    amountPaise: z.number().int(),
    failureReason: z.string().optional(),
  }),
});

export function verifySignature(ctx: AppContext, rawBody: string, header: string | undefined): void {
  const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  const invalid = () => new AppError('WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature');
  if (!Number.isSafeInteger(t) || !v1) throw invalid();
  const ageSeconds = Math.abs(ctx.clock.now().getTime() / 1000 - t);
  if (ageSeconds > business.payments.webhookToleranceSeconds) throw invalid();
  if (!safeEqual(v1, hmacSha256(ctx.env.PAYMENT_WEBHOOK_SECRET, `${t}.${rawBody}`))) throw invalid();
}

/**
 * Signed gateway callback. Verified, deduplicated by event id (`payment_events.event_id` unique),
 * and applied in one transaction — a failure rolls back the dedupe row too, so the gateway's retry
 * is processed again.
 */
export async function processWebhook(ctx: AppContext, rawBody: string, signature: string | undefined) {
  verifySignature(ctx, rawBody, signature);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Malformed webhook body');
  }
  const event = webhookEventSchema.parse(parsed);

  const result = await ctx.db.transaction(async (tx) => {
    const attempt = await tx.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.gatewayRef, event.data.gatewayRef) });
    if (!attempt) throw new AppError('NOT_FOUND', 'Unknown payment');
    const [recorded] = await tx
      .insert(paymentEvents)
      .values({ eventId: event.id, attemptId: attempt.id, type: event.type, payload: event, receivedAt: ctx.clock.now() })
      .onConflictDoNothing()
      .returning({ id: paymentEvents.id });
    if (!recorded) return { duplicate: true, stockChanged: false };

    const locked = (await lockAttemptAndOrder(tx, attempt.id))!;
    let applied: ApplyResult;
    if (event.data.amountPaise !== locked.attempt.amountPaise) {
      await recordOrderEvent(ctx, tx, locked.order.id, 'payment_event_ignored', { attemptId: attempt.id, why: 'amount_mismatch', eventId: event.id });
      applied = { stockChanged: false, needsWebhook: false, ignored: 'amount_mismatch' };
    } else {
      const outcome: Outcome =
        event.type === 'payment.pending'
          ? { type: 'pending' }
          : event.type === 'payment.succeeded'
            ? { type: 'succeeded' }
            : { type: event.type === 'payment.failed' ? 'failed' : 'cancelled', reason: event.data.failureReason ?? null };
      applied = await applyOutcome(ctx, tx, locked.attempt, locked.order, outcome, 'webhook');
    }
    await tx.update(paymentEvents).set({ processedAt: ctx.clock.now() }).where(eq(paymentEvents.id, recorded.id));
    return { duplicate: false, stockChanged: applied.stockChanged, ignored: applied.ignored };
  });

  if (result.stockChanged) ctx.catalog.invalidate();
  return { received: true, duplicate: result.duplicate, ...(result.ignored ? { ignored: result.ignored } : {}) };
}

/* ---------------- jobs ---------------- */

/**
 * Job `payment.reconcile`: an attempt is past its expiry without a final webhook. Ask the gateway.
 * Still processing → look again later. Settled → apply it (a late success is redelivered as a
 * webhook instead, since only the webhook may revive an expired order).
 */
export async function reconcileAttempt(ctx: AppContext, attemptId: string): Promise<void> {
  const attempt = await ctx.db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId) });
  if (!attempt || isTerminal(attempt.status)) return;
  const report = await gateway.queryCharge(ctx, attempt.gatewayRef);

  if (report.status === 'processing') {
    const base = report.resolveAt && report.resolveAt > ctx.clock.now() ? report.resolveAt : ctx.clock.now();
    await enqueue(ctx.db, 'payment.reconcile', { attemptId }, { runAt: new Date(base.getTime() + business.payments.reconcileGraceSeconds * 1000) });
    return;
  }

  const outcome: Outcome =
    report.status === 'succeeded'
      ? { type: 'succeeded' }
      : report.status === 'failed'
        ? { type: 'failed', reason: report.failureReason }
        : report.status === 'cancelled'
          ? { type: 'cancelled', reason: report.failureReason ?? 'user_cancelled' }
          : { type: 'expired', reason: 'timeout' };

  const stockChanged = await ctx.db.transaction(async (tx) => {
    const locked = await lockAttemptAndOrder(tx, attemptId);
    if (!locked) return false;
    if (report.status === 'created') await gateway.voidCharge(ctx, tx, attempt.gatewayRef);
    const applied = await applyOutcome(ctx, tx, locked.attempt, locked.order, outcome, 'reconcile');
    if (applied.needsWebhook) {
      await gateway.redeliverFinalEvent(ctx, tx, attempt.gatewayRef);
      await recordOrderEvent(ctx, tx, locked.order.id, 'late_payment_redelivery_requested', { attemptId });
    }
    return applied.stockChanged;
  });
  if (stockChanged) ctx.catalog.invalidate();
}

/**
 * Job `reservation.expire`: the 15-minute window is over. Unsubmitted attempts are voided at the
 * gateway; the order expires and releases stock, coupon and points. A submitted attempt is left to
 * settle — if it succeeds, the late-success path takes over.
 */
export async function expireReservation(ctx: AppContext, orderId: string): Promise<void> {
  const expired = await ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order || !isLiveUnpaid(order.status)) return false;
    if (order.reservationExpiresAt && order.reservationExpiresAt > ctx.clock.now()) {
      await enqueue(tx, 'reservation.expire', { orderId }, { runAt: order.reservationExpiresAt });
      return false;
    }
    const open = await tx
      .select()
      .from(paymentAttempts)
      .where(and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.status, 'CREATED')))
      .for('update');
    for (const a of open) {
      if (await gateway.voidCharge(ctx, tx, a.gatewayRef)) {
        await transitionAttempt(ctx, tx, a, 'EXPIRED', { failureReason: 'order_expired' });
      }
    }
    return expireOrder(ctx, tx, order);
  });
  if (expired) ctx.catalog.invalidate();
}
