import { formatINR } from '@avero/shared';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Tx } from '../../db/client';
import { cartItems, carts, checkoutSessions, orderItems, orders } from '../../db/schema';
import { orderConfirmedTemplate, orderUnfulfillableTemplate } from '../../lib/email-templates';
import { AppError } from '../../lib/errors';
import { recordOrderEvent, transitionOrder, transitionOrderItems, type AttemptRow, type OrderRow } from '../../lib/transitions';
import { bumpVersion } from '../cart/service';
import { estimateDelivery } from '../delivery/pincode';
import { scheduleFulfilment } from '../fulfilment/service';
import { commitReservations, releaseReservations, reserveLines } from '../inventory/reservations';
import { recordEarn, reclaimPoints, reversePoints } from '../loyalty/points';
import { reclaimCoupon, releaseCoupon } from '../promotions/coupons';
import { notify } from '../notifications/service';
import { createRefund } from '../refunds/service';
import { markQualifyingOrder } from '../referrals/service';
import { orderLink } from './access';

/**
 * Order-side effects of payment outcomes and reservation expiry. Every function runs inside the
 * caller's transaction; side effects (emails) are enqueued as jobs in that same transaction.
 * Callers invalidate the catalog index after commit when stock moved.
 */

export const LIVE_UNPAID_STATUSES = ['PENDING_PAYMENT', 'PAYMENT_FAILED'] as const;
export const isLiveUnpaid = (s: OrderRow['status']) => (LIVE_UNPAID_STATUSES as readonly string[]).includes(s);

export type SuccessResult = 'confirmed' | 'unfulfillable' | 'already_paid';

/**
 * A payment attempt for this order succeeded (the attempt row is already SUCCEEDED).
 * - awaiting payment → PAID → commit stock → CONFIRMED
 * - EXPIRED (late success, webhook only) → PAID → re-reserve → CONFIRMED, or
 *   PAID_UNFULFILLABLE → CANCELLED with a full refund
 */
export async function onPaymentSucceeded(
  ctx: AppContext,
  tx: Tx,
  order: OrderRow,
  attempt: AttemptRow,
): Promise<SuccessResult> {
  const paid = { paidPaise: attempt.amountPaise };
  const meta = { attemptId: attempt.id, method: attempt.method };

  if (order.status === 'PAYMENT_FAILED') {
    order = await transitionOrder(ctx, tx, order, 'PENDING_PAYMENT', { event: 'payment_resumed', meta });
  }
  if (order.status === 'PENDING_PAYMENT') {
    order = await transitionOrder(ctx, tx, order, 'PAID', { event: 'payment_succeeded', meta, set: paid });
    await commitReservations(ctx, tx, order.id);
    await confirm(ctx, tx, order);
    return 'confirmed';
  }
  if (order.status === 'EXPIRED') {
    order = await transitionOrder(ctx, tx, order, 'PAID', {
      event: 'late_payment_succeeded',
      meta,
      set: paid,
      latePaymentFromWebhook: true,
    });
    return lateSuccess(ctx, tx, order);
  }
  throw new AppError('INVALID_STATE_TRANSITION', `Order ${order.orderNumber} is ${order.status}; cannot apply a payment`);
}

/** EXPIRED → PAID happened; stock and offers were released at expiry and must be taken again. */
async function lateSuccess(ctx: AppContext, tx: Tx, order: OrderRow): Promise<SuccessResult> {
  const items = await tx.query.orderItems.findMany({ where: eq(orderItems.orderId, order.id) });
  const now = ctx.clock.now();
  let restocked = true;
  try {
    // Savepoint: a partial re-reserve must not leave some lines reserved.
    await tx.transaction(async (sp) => {
      await reserveLines(
        sp,
        order.id,
        items.map((i) => ({ skuId: i.skuId, qty: i.qty, sizeLabel: i.sizeLabel, productName: i.productName })),
        now,
      );
      await commitReservations(ctx, sp, order.id);
    });
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'SKU_OUT_OF_STOCK') throw err;
    restocked = false;
  }

  if (!restocked) {
    order = await transitionOrder(ctx, tx, order, 'PAID_UNFULFILLABLE', { event: 'stock_unavailable_after_late_payment' });
    order = await transitionOrder(ctx, tx, order, 'CANCELLED', {
      event: 'order_cancelled',
      meta: { reason: 'unfulfillable', refundPaise: order.paidPaise },
      set: { cancelledAt: now },
    });
    await transitionOrderItems(ctx, tx, order.id, 'ACTIVE', 'CANCELLED', 'item_cancelled');
    await createRefund(ctx, tx, {
      order,
      amountPaise: order.paidPaise,
      destination: 'original',
      reason: 'unfulfillable',
      key: `unfulfillable:${order.id}`,
    });
    await recordOrderEvent(ctx, tx, order.id, 'refund_initiated', { amountPaise: order.paidPaise, reason: 'unfulfillable' });
    await notify(ctx, tx, {
      userId: order.userId,
      kind: 'order',
      title: `Order ${order.orderNumber} couldn’t be completed`,
      body: 'Your payment arrived after the items sold out. A full refund is on its way.',
      link: order.userId ? `/account/orders/${order.orderNumber}` : null,
      email: orderUnfulfillableTemplate(order.email, order, orderLink(ctx, order)),
    });
    return 'unfulfillable';
  }

  // The shopper paid the quoted price; honour it even if the offer can't be re-taken.
  const coupon = await reclaimCoupon(tx, order.id);
  if (coupon === 'over_limit') {
    await recordOrderEvent(ctx, tx, order.id, 'coupon_honoured_over_limit', { couponCode: order.couponCode });
  }
  const points = await reclaimPoints(tx, order.id);
  if (points === 'insufficient') {
    await recordOrderEvent(ctx, tx, order.id, 'points_honoured_without_balance', { points: order.pointsRedeemed });
  }
  await confirm(ctx, tx, order);
  return 'confirmed';
}

/** PAID → CONFIRMED plus the success side effects. */
async function confirm(ctx: AppContext, tx: Tx, order: OrderRow): Promise<void> {
  const now = ctx.clock.now();
  const option = estimateDelivery(order.address.pincode, now).options.find((o) => o.method === order.shippingMethod);
  // Latest promised date, end of the courier day (18:00 IST).
  const expectedDeliveryAt = option ? new Date(`${option.latest}T12:30:00Z`) : null;
  order = await transitionOrder(ctx, tx, order, 'CONFIRMED', { event: 'order_confirmed', set: { expectedDeliveryAt } });

  const pointsEarned = await recordEarn(tx, order);
  if (order.kind === 'sale') await markQualifyingOrder(tx, order);
  await subtractFromBag(tx, order);

  const items = await tx.query.orderItems.findMany({ where: eq(orderItems.orderId, order.id) });
  await notify(ctx, tx, {
    userId: order.userId,
    kind: 'order',
    title: `Order ${order.orderNumber} confirmed`,
    body: `We’ve received your payment of ${formatINR(order.paidPaise)}.`,
    link: order.userId ? `/account/orders/${order.orderNumber}` : null,
    email: orderConfirmedTemplate(
      order.email,
      { orderNumber: order.orderNumber, totalPaise: order.paidPaise, expectedDeliveryAt, pointsEarned },
      items.map((i) => ({ productName: i.productName, colorwayName: i.colorwayName, sizeLabel: i.sizeLabel, qty: i.qty, totalPaise: i.totalPaise })),
      orderLink(ctx, order),
    ),
  });
  await scheduleFulfilment(ctx, tx, order);
}

/**
 * Removes what was bought from the bag the order came from (deviation from the original spec,
 * which converted the whole bag: see docs/BUSINESS_RULES.md §Bag). Uses the order's line snapshot,
 * only touches in-bag lines (never saved-for-later), deletes lines that reach zero.
 */
async function subtractFromBag(tx: Tx, order: OrderRow): Promise<void> {
  if (!order.checkoutSessionId) return; // exchange replacement orders never came from a bag
  const session = await tx.query.checkoutSessions.findFirst({ where: eq(checkoutSessions.id, order.checkoutSessionId) });
  let cart = session ? await tx.query.carts.findFirst({ where: and(eq(carts.id, session.cartId), eq(carts.status, 'active')) }) : undefined;
  // A guest who signed in after ordering had their bag merged into their account bag.
  if (!cart && order.userId) {
    cart = await tx.query.carts.findFirst({ where: and(eq(carts.userId, order.userId), eq(carts.status, 'active')) });
  }
  if (!cart) return;

  const items = await tx.query.orderItems.findMany({ where: eq(orderItems.orderId, order.id) });
  let changed = false;
  for (const item of items) {
    const line = await tx.query.cartItems.findFirst({
      where: and(eq(cartItems.cartId, cart.id), eq(cartItems.skuId, item.skuId), eq(cartItems.savedForLater, false)),
    });
    if (!line) continue;
    changed = true;
    if (line.qty <= item.qty) await tx.delete(cartItems).where(eq(cartItems.id, line.id));
    else await tx.update(cartItems).set({ qty: line.qty - item.qty }).where(eq(cartItems.id, line.id));
  }
  if (changed) await bumpVersion(tx, cart.id);
}

/**
 * An attempt ended without payment (failed / cancelled / expired). The order becomes PAYMENT_FAILED
 * but keeps its reservation, coupon and points so the shopper can retry until it expires.
 */
export async function onPaymentNotCompleted(
  ctx: AppContext,
  tx: Tx,
  order: OrderRow,
  attempt: AttemptRow,
): Promise<void> {
  if (order.status !== 'PENDING_PAYMENT') return;
  await transitionOrder(ctx, tx, order, 'PAYMENT_FAILED', {
    event: 'payment_failed',
    meta: { attemptId: attempt.id, attemptStatus: attempt.status, reason: attempt.failureReason },
  });
}

/** Reservation window over without payment: release stock, coupon and points; bag untouched. */
export async function expireOrder(ctx: AppContext, tx: Tx, order: OrderRow): Promise<boolean> {
  if (!isLiveUnpaid(order.status)) return false;
  const released = await releaseReservations(ctx, tx, order.id);
  const couponCode = await releaseCoupon(tx, order.id);
  const pointsRestored = await reversePoints(tx, order.id);
  await transitionOrder(ctx, tx, order, 'EXPIRED', {
    event: 'order_expired',
    meta: { reservationsReleased: released, couponReleased: couponCode, pointsRestored },
  });
  return true;
}

export async function lockOrder(tx: Tx, orderId: string): Promise<OrderRow | undefined> {
  const [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
  return row;
}
