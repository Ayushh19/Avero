import { formatINR } from '@avero/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import type { Tx } from '../../db/client';
import { inventoryMovements, orderItems, orders, refunds, skus } from '../../db/schema';
import { noticeTemplate } from '../../lib/email-templates';
import { AppError } from '../../lib/errors';
import { recordOrderEvent, transitionItems, transitionOrder, type OrderRow } from '../../lib/transitions';
import { adjustPendingEarn } from '../loyalty/points';
import { notify } from '../notifications/service';
import { releaseCoupon } from '../promotions/coupons';
import { createRefund } from '../refunds/service';
import { releaseQualifyingOrder } from '../referrals/service';
import { canAccessOrder, orderLink } from './access';

/** Before the parcel leaves (docs/BUSINESS_RULES.md 18). */
export const CANCELLABLE_STATUSES = ['PAID', 'CONFIRMED', 'PACKED'] as const;
export const isCancellable = (o: Pick<OrderRow, 'status' | 'kind'>) =>
  o.kind === 'sale' && (CANCELLABLE_STATUSES as readonly string[]).includes(o.status);

type ItemRow = typeof orderItems.$inferSelect;

/** Puts cancelled/returned units back on sale. */
export async function restock(tx: Tx, items: ItemRow[], reason: 'restock_cancel' | 'restock_return'): Promise<void> {
  for (const item of items) {
    await tx.update(skus).set({ onHand: sql`${skus.onHand} + ${item.qty}` }).where(eq(skus.id, item.skuId));
    await tx.insert(inventoryMovements).values({ skuId: item.skuId, deltaOnHand: item.qty, reason, refType: 'order_item', refId: item.id });
    await tx.execute(sql`UPDATE products SET sold_count = GREATEST(0, sold_count - ${item.qty}) WHERE id = ${item.productId}`);
  }
}

/**
 * Redeemed points to give back for these lines. Lines carry their share of the points discount in
 * paise; the last refund of an order returns whatever is left so the total matches exactly.
 */
export async function pointsToReturn(tx: Tx, order: OrderRow, lines: ItemRow[], last: boolean): Promise<number> {
  if (!order.userId || order.pointsRedeemed === 0) return 0;
  const [{ given }] = (await tx
    .select({ given: sql<number>`coalesce(sum(${refunds.pointsAmount}), 0)::int` })
    .from(refunds)
    .where(eq(refunds.orderId, order.id))) as [{ given: number }];
  const remaining = order.pointsRedeemed - given;
  if (last) return Math.max(0, remaining);
  const share = Math.round(lines.reduce((s, l) => s + l.pointsDiscountPaise, 0) / business.points.pointValuePaise);
  return Math.min(share, remaining);
}

function notCancellableMessage(order: OrderRow): string {
  if (order.kind === 'exchange') return 'Exchange orders can’t be cancelled. You can return the item after it’s delivered.';
  if (['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(order.status)) {
    return 'This order has already shipped, so it can’t be cancelled. You can return it after delivery.';
  }
  return 'This order can’t be cancelled';
}

/**
 * Cancels whole lines (or every active line) before shipping: items → CANCELLED, stock back on
 * sale, refund of the lines' paid share (+ shipping on a full cancel), redeemed points returned,
 * coupon released on a full cancel, pending earn reduced. Run under `withIdempotency`.
 */
export async function cancelOrder(
  ctx: AppContext,
  req: FastifyRequest,
  orderNumber: string,
  input: { itemIds?: string[]; reason: string },
  token?: string,
): Promise<OrderRow> {
  const found = await ctx.db.query.orders.findFirst({ where: eq(orders.orderNumber, orderNumber.toUpperCase()) });
  if (!found || !canAccessOrder(ctx, req, found, token)) throw new AppError('NOT_FOUND', 'Order not found');

  const result = await ctx.db.transaction(async (tx) => {
    let [order] = await tx.select().from(orders).where(eq(orders.id, found.id)).for('update');
    if (!order || !isCancellable(order)) throw new AppError('ORDER_NOT_CANCELLABLE', notCancellableMessage(order ?? found));

    const items = await tx.query.orderItems.findMany({ where: eq(orderItems.orderId, order.id) });
    const active = items.filter((i) => i.status === 'ACTIVE');
    const targets = input.itemIds ? items.filter((i) => input.itemIds!.includes(i.id)) : active;
    if (input.itemIds && (targets.length !== new Set(input.itemIds).size || targets.some((i) => i.status !== 'ACTIVE'))) {
      throw new AppError('ORDER_NOT_CANCELLABLE', 'Some of these items have already been cancelled');
    }
    if (targets.length === 0) throw new AppError('ORDER_NOT_CANCELLABLE', 'There’s nothing left to cancel on this order');
    const full = targets.length === active.length;
    const ids = targets.map((i) => i.id).sort();

    await transitionItems(ctx, tx, order.id, ids, 'ACTIVE', 'CANCELLED', 'item_cancelled', { reason: input.reason });
    await restock(tx, targets, 'restock_cancel');

    const amount = targets.reduce((s, i) => s + i.totalPaise, 0) + (full ? order.shippingPaise : 0);
    const points = await pointsToReturn(tx, order, targets, full);
    if (full) {
      await releaseCoupon(tx, order.id);
      await releaseQualifyingOrder(tx, order.id);
      order = await transitionOrder(ctx, tx, order, 'CANCELLED', {
        event: 'order_cancelled',
        meta: { reason: input.reason, by: 'customer' },
        set: { cancelledAt: ctx.clock.now() },
      });
    } else {
      await recordOrderEvent(ctx, tx, order.id, 'items_cancelled', { itemIds: ids, reason: input.reason });
    }
    if (amount > 0 || points > 0) {
      await createRefund(ctx, tx, {
        order,
        amountPaise: amount,
        pointsToReturn: points,
        destination: 'original',
        reason: 'cancellation',
        key: `cancel:${order.id}:${ids.join(',')}`,
      });
    }
    await adjustPendingEarn(tx, order);

    const what = full ? `Order ${order.orderNumber} cancelled` : `${targets.length} ${targets.length === 1 ? 'item' : 'items'} cancelled from order ${order.orderNumber}`;
    const refundText = amount > 0 ? `A refund of ${formatINR(amount)} is on its way to your original payment method.` : '';
    const pointsText = points > 0 ? `${points} points have been returned to your balance.` : '';
    await notify(ctx, tx, {
      userId: order.userId,
      kind: 'order',
      title: what,
      body: [refundText, pointsText].filter(Boolean).join(' ') || 'No payment was taken for these items.',
      link: order.userId ? `/account/orders/${order.orderNumber}` : null,
      email: noticeTemplate({
        to: order.email,
        template: 'order_cancelled',
        subject: what,
        heading: full ? 'Your order is cancelled' : 'Items cancelled',
        paragraphs: [
          full ? `We’ve cancelled order ${order.orderNumber}.` : `We’ve cancelled ${targets.map((t) => `${t.productName} (UK ${t.sizeLabel})`).join(', ')}.`,
          refundText,
          pointsText,
        ].filter(Boolean),
        link: { href: orderLink(ctx, order), label: 'View your order' },
      }),
    });
    return order;
  });

  ctx.catalog.invalidate();
  return result;
}
