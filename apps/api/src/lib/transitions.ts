import {
  ORDER_ITEM_TRANSITIONS,
  ORDER_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  REFUND_TRANSITIONS,
  RETURN_TRANSITIONS,
  canTransition,
  type OrderItemStatus,
  type OrderStatus,
  type PaymentStatus,
  type RefundStatus,
  type ReturnStatus,
} from '@avero/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { Tx } from '../db/client';
import { orderEvents, orderItems, orders, paymentAttempts, refunds, returnRequests } from '../db/schema';
import { AppError } from './errors';

export type OrderRow = typeof orders.$inferSelect;
export type AttemptRow = typeof paymentAttempts.$inferSelect;
export type RefundRow = typeof refunds.$inferSelect;
export type ReturnRow = typeof returnRequests.$inferSelect;

/** Throws INVALID_STATE_TRANSITION unless `from → to` is in the map (docs/STATE_MACHINES.md). */
export function assertTransition<S extends string>(
  map: Record<S, readonly S[]>,
  from: S,
  to: S,
  entity: string,
): void {
  if (!canTransition(map, from, to)) {
    throw new AppError('INVALID_STATE_TRANSITION', `Cannot move ${entity} from ${from} to ${to}`, { from, to });
  }
}

export interface OrderTransitionOptions {
  /** order_events.type, e.g. "payment_succeeded". */
  event: string;
  meta?: Record<string, unknown>;
  /** Extra columns to set with the status change. */
  set?: Partial<typeof orders.$inferInsert>;
  /**
   * EXPIRED → PAID is reserved for the payment webhook handler reporting a real capture
   * (late success). Every other caller leaves this unset and EXPIRED stays terminal.
   */
  latePaymentFromWebhook?: boolean;
  /** When it happened, if not now (a scheduled step processed late after a clock jump). */
  at?: Date;
}

/**
 * The only way to change `orders.status`. Validates against the transition map, applies the change
 * conditionally on the current status (so concurrent writers can't both win) and writes an
 * `order_events` row. Returns the updated row.
 */
export async function transitionOrder(
  ctx: AppContext,
  tx: Tx,
  order: OrderRow,
  to: OrderStatus,
  opts: OrderTransitionOptions,
): Promise<OrderRow> {
  try {
    assertTransition(ORDER_TRANSITIONS, order.status, to, `order ${order.orderNumber}`);
    if (order.status === 'EXPIRED' && to === 'PAID' && !opts.latePaymentFromWebhook) {
      throw new AppError('INVALID_STATE_TRANSITION', 'Only a late payment webhook may revive an expired order', {
        from: order.status,
        to,
      });
    }
  } catch (err) {
    console.warn(`[transition] rejected order ${order.orderNumber}: ${order.status} → ${to} (${opts.event})`);
    throw err;
  }
  const [updated] = await tx
    .update(orders)
    .set({ ...opts.set, status: to, version: sql`${orders.version} + 1` })
    .where(and(eq(orders.id, order.id), eq(orders.status, order.status)))
    .returning();
  if (!updated) {
    throw new AppError('INVALID_STATE_TRANSITION', `Order ${order.orderNumber} changed concurrently`, { from: order.status, to });
  }
  await tx.insert(orderEvents).values({
    orderId: order.id,
    type: opts.event,
    fromStatus: order.status,
    toStatus: to,
    meta: opts.meta,
    occurredAt: opts.at ?? ctx.clock.now(),
  });
  return updated;
}

/** Records an order_events row without a status change (e.g. "coupon honoured over limit"). */
export async function recordOrderEvent(
  ctx: AppContext,
  tx: Tx,
  orderId: string,
  event: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(orderEvents).values({ orderId, type: event, meta, occurredAt: ctx.clock.now() });
}

/** Moves every order item currently in `from` to `to`, writing one event per item. */
export async function transitionOrderItems(
  ctx: AppContext,
  tx: Tx,
  orderId: string,
  from: OrderItemStatus,
  to: OrderItemStatus,
  event: string,
  when?: Date,
): Promise<void> {
  assertTransition(ORDER_ITEM_TRANSITIONS, from, to, 'order item');
  const moved = await tx
    .update(orderItems)
    .set({ status: to })
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, from)))
    .returning({ id: orderItems.id });
  if (moved.length === 0) return;
  const at = when ?? ctx.clock.now();
  await tx.insert(orderEvents).values(
    moved.map((m) => ({ orderId, orderItemId: m.id, type: event, fromStatus: from, toStatus: to, occurredAt: at })),
  );
}

/** The only way to change `payment_attempts.status`. Conditional on the current status. */
export async function transitionAttempt(
  ctx: AppContext,
  tx: Tx,
  attempt: AttemptRow,
  to: PaymentStatus,
  set: Partial<typeof paymentAttempts.$inferInsert> = {},
): Promise<AttemptRow> {
  assertTransition(PAYMENT_TRANSITIONS, attempt.status, to, `payment attempt ${attempt.id}`);
  const terminal = to !== 'PENDING';
  const [updated] = await tx
    .update(paymentAttempts)
    .set({ ...set, status: to, ...(terminal ? { settledAt: ctx.clock.now() } : {}) })
    .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, attempt.status)))
    .returning();
  if (!updated) {
    throw new AppError('INVALID_STATE_TRANSITION', `Payment attempt ${attempt.id} changed concurrently`);
  }
  return updated;
}

/** Moves specific order items (whole lines) from `from` to `to`, one event per item. */
export async function transitionItems(
  ctx: AppContext,
  tx: Tx,
  orderId: string,
  itemIds: string[],
  from: OrderItemStatus,
  to: OrderItemStatus,
  event: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  if (itemIds.length === 0) return;
  assertTransition(ORDER_ITEM_TRANSITIONS, from, to, 'order item');
  const moved = await tx
    .update(orderItems)
    .set({ status: to })
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, from), inArray(orderItems.id, itemIds)))
    .returning({ id: orderItems.id });
  if (moved.length !== itemIds.length) {
    throw new AppError('INVALID_STATE_TRANSITION', `Some items are no longer ${from.toLowerCase().replace('_', ' ')}`);
  }
  const at = ctx.clock.now();
  await tx.insert(orderEvents).values(
    moved.map((m) => ({ orderId, orderItemId: m.id, type: event, fromStatus: from, toStatus: to, meta, occurredAt: at })),
  );
}

/** The only way to change `refunds.status`. Conditional on the current status. */
export async function transitionRefund(
  tx: Tx,
  refund: RefundRow,
  to: RefundStatus,
  set: Partial<typeof refunds.$inferInsert> = {},
): Promise<RefundRow> {
  assertTransition(REFUND_TRANSITIONS, refund.status, to, `refund ${refund.id}`);
  const [updated] = await tx
    .update(refunds)
    .set({ ...set, status: to })
    .where(and(eq(refunds.id, refund.id), eq(refunds.status, refund.status)))
    .returning();
  if (!updated) throw new AppError('INVALID_STATE_TRANSITION', `Refund ${refund.id} changed concurrently`);
  return updated;
}

/**
 * The only way to change `return_requests.status`. Writes an order_events row (type
 * `return_status`, meta.rmaNumber) so the order timeline shows return progress too.
 */
export async function transitionReturn(
  ctx: AppContext,
  tx: Tx,
  ret: ReturnRow,
  to: ReturnStatus,
  set: Partial<typeof returnRequests.$inferInsert> = {},
): Promise<ReturnRow> {
  assertTransition(RETURN_TRANSITIONS, ret.status, to, `return ${ret.rmaNumber}`);
  const [updated] = await tx
    .update(returnRequests)
    .set({ ...set, status: to })
    .where(and(eq(returnRequests.id, ret.id), eq(returnRequests.status, ret.status)))
    .returning();
  if (!updated) throw new AppError('INVALID_STATE_TRANSITION', `Return ${ret.rmaNumber} changed concurrently`);
  await tx.insert(orderEvents).values({
    orderId: ret.orderId,
    type: 'return_status',
    fromStatus: ret.status,
    toStatus: to,
    meta: { rmaNumber: ret.rmaNumber, kind: ret.kind },
    occurredAt: ctx.clock.now(),
  });
  return updated;
}
