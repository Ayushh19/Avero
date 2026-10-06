import type { OrderDto, OrderListDto, OrderSummaryDto, PaymentAttemptDto, ShippingMethod } from '@avero/shared';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context';
import type { DbOrTx } from '../../db/client';
import { orderEvents, orderItems, orders, paymentAttempts, pointsLedger, refunds, shipments } from '../../db/schema';
import { AppError } from '../../lib/errors';
import type { AttemptRow, OrderRow } from '../../lib/transitions';
import { requireUser } from '../../plugins/session';
import { canAccessOrder, signOrderToken } from './access';
import { toRefundDto } from '../refunds/service';
import { canReturnAny, returnSummaries } from '../returns/service';
import { isCancellable } from './cancellation';
import { invoiceAvailable } from './invoice';
import { isLiveUnpaid } from './lifecycle';

export function toAttemptDto(a: AttemptRow, orderNumber: string): PaymentAttemptDto {
  return {
    id: a.id,
    orderNumber,
    method: a.method,
    status: a.status,
    amountPaise: a.amountPaise,
    failureReason: a.failureReason,
    gatewayRef: a.gatewayRef,
    expiresAt: a.expiresAt.toISOString(),
    settledAt: a.settledAt?.toISOString() ?? null,
  };
}

/** Payment can be started now: unpaid, reservation alive, nothing in flight. */
export function canPay(ctx: AppContext, order: OrderRow, latest: AttemptRow | undefined): boolean {
  return (
    isLiveUnpaid(order.status) &&
    order.reservationExpiresAt !== null &&
    order.reservationExpiresAt > ctx.clock.now() &&
    latest?.status !== 'PENDING'
  );
}

export async function latestAttempt(db: DbOrTx, orderId: string): Promise<AttemptRow | undefined> {
  return db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.orderId, orderId), orderBy: desc(paymentAttempts.createdAt) });
}

export async function toOrderDto(ctx: AppContext, order: OrderRow): Promise<OrderDto> {
  const [items, events, latest, earn, shipmentRows, refundRows, returns, parent] = await Promise.all([
    ctx.db.query.orderItems.findMany({ where: eq(orderItems.orderId, order.id), orderBy: asc(orderItems.createdAt) }),
    ctx.db.query.orderEvents.findMany({ where: eq(orderEvents.orderId, order.id), orderBy: asc(orderEvents.occurredAt) }),
    latestAttempt(ctx.db, order.id),
    ctx.db.query.pointsLedger.findFirst({ where: and(eq(pointsLedger.orderId, order.id), eq(pointsLedger.kind, 'earn')) }),
    ctx.db.query.shipments.findMany({ where: eq(shipments.orderId, order.id), orderBy: asc(shipments.createdAt) }),
    ctx.db.query.refunds.findMany({ where: eq(refunds.orderId, order.id), orderBy: asc(refunds.createdAt) }),
    returnSummaries(ctx.db, { orderId: order.id }),
    order.parentOrderId ? ctx.db.query.orders.findFirst({ where: eq(orders.id, order.parentOrderId), columns: { orderNumber: true } }) : null,
  ]);
  const cancellable = isCancellable(order);
  const tracking = events.filter((e) => e.type === 'tracking');
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    placedAt: order.placedAt.toISOString(),
    email: order.email,
    phone: order.phone,
    isGuest: order.userId === null,
    address: {
      ...order.address,
      line2: order.address.line2 ?? undefined,
      landmark: order.address.landmark ?? undefined,
      state: order.address.state as OrderDto['address']['state'],
    },
    shippingMethod: order.shippingMethod as ShippingMethod,
    items: items.map((i) => ({
      id: i.id,
      skuId: i.skuId,
      productName: i.productName,
      productSlug: i.productSlug,
      colorName: i.colorwayName,
      sizeLabel: i.sizeLabel,
      href: `/p/${i.productSlug}/${i.colorwaySlug}`,
      imageUrl: i.imageUrl,
      qty: i.qty,
      unitPricePaise: i.unitPricePaise,
      mrpPaise: i.mrpPaise,
      discountPaise: i.discountPaise,
      pointsDiscountPaise: i.pointsDiscountPaise,
      totalPaise: i.totalPaise,
      status: i.status,
      cancellable: cancellable && i.status === 'ACTIVE',
    })),
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    couponCode: order.couponCode,
    shippingPaise: order.shippingPaise,
    pointsRedeemed: order.pointsRedeemed,
    pointsDiscountPaise: order.pointsDiscountPaise,
    totalPaise: order.totalPaise,
    taxIncludedPaise: order.taxPaise,
    paidPaise: order.paidPaise,
    refundedPaise: order.refundedPaise,
    pointsEarned: earn && earn.status !== 'void' ? earn.delta : 0,
    reservationExpiresAt: order.reservationExpiresAt?.toISOString() ?? null,
    expectedDeliveryAt: order.expectedDeliveryAt?.toISOString() ?? null,
    canPay: canPay(ctx, order, latest),
    latestPayment: latest ? toAttemptDto(latest, order.orderNumber) : null,
    events: events
      .filter((e) => !e.orderItemId && e.type !== 'tracking')
      .map((e) => ({ type: e.type, fromStatus: e.fromStatus, toStatus: e.toStatus, at: e.occurredAt.toISOString() })),
    kind: order.kind,
    parentOrderNumber: parent?.orderNumber ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    returnWindowEndsAt: order.returnWindowEndsAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    canCancel: cancellable && items.some((i) => i.status === 'ACTIVE'),
    canReturn: canReturnAny(ctx, order, items),
    invoiceAvailable: invoiceAvailable(order),
    shipments: shipmentRows.map((sh) => ({
      kind: sh.kind,
      carrier: sh.carrier,
      trackingNumber: sh.trackingNumber,
      status: sh.status,
      events: tracking
        .filter((e) => (e.meta as { shipmentId?: string } | null)?.shipmentId === sh.id)
        .map((e) => {
          const m = e.meta as { status: string; description: string; location: string | null };
          return { status: m.status, description: m.description, location: m.location, at: e.occurredAt.toISOString() };
        })
        .reverse(),
    })),
    refunds: refundRows.filter((r) => r.reason !== 'duplicate_capture').map(toRefundDto),
    returns,
  };
}

/** Loads an order the requester may see; NOT_FOUND otherwise (never reveals existence). */
export async function accessibleOrder(ctx: AppContext, req: FastifyRequest, orderNumber: string, token?: string): Promise<OrderRow> {
  const order = await ctx.db.query.orders.findFirst({ where: eq(orders.orderNumber, orderNumber.toUpperCase()) });
  if (!order || !canAccessOrder(ctx, req, order, token)) throw new AppError('NOT_FOUND', 'Order not found');
  return order;
}

/** Orders the shopper has actually placed and paid for (abandoned unpaid ones stay out of history). */
const HISTORY_HIDDEN = ['EXPIRED'] as const;

export async function listOrders(ctx: AppContext, req: FastifyRequest): Promise<OrderListDto> {
  const user = requireUser(req);
  const rows = await ctx.db.query.orders.findMany({
    where: and(eq(orders.userId, user.id), notInArray(orders.status, [...HISTORY_HIDDEN])),
    orderBy: desc(orders.placedAt),
    limit: 100,
  });
  const items = rows.length
    ? await ctx.db.query.orderItems.findMany({ where: inArray(orderItems.orderId, rows.map((r) => r.id)), orderBy: asc(orderItems.createdAt) })
    : [];
  const summaries: OrderSummaryDto[] = rows.map((o) => {
    const mine = items.filter((i) => i.orderId === o.id);
    return {
      orderNumber: o.orderNumber,
      status: o.status,
      placedAt: o.placedAt.toISOString(),
      totalPaise: o.totalPaise,
      itemCount: mine.reduce((s, i) => s + i.qty, 0),
      images: mine.map((i) => i.imageUrl).filter((u): u is string => Boolean(u)).slice(0, 4),
    };
  });
  return { orders: summaries, claimable: user.emailVerifiedAt ? await claimableCount(ctx, user.email) : 0 };
}

async function claimableCount(ctx: AppContext, email: string): Promise<number> {
  const [row] = (await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(isNull(orders.userId), eq(orders.email, email), sql`${orders.paidPaise} > 0`))) as [{ n: number }];
  return row.n;
}

/** Adds paid guest orders placed with the account's (verified) email to the account. */
export async function claimGuestOrders(ctx: AppContext, req: FastifyRequest): Promise<{ claimed: number }> {
  const user = requireUser(req);
  if (!user.emailVerifiedAt) throw new AppError('FORBIDDEN', 'Verify your email address to add past orders to your account');
  const claimed = await ctx.db
    .update(orders)
    .set({ userId: user.id })
    .where(and(isNull(orders.userId), eq(orders.email, user.email), sql`${orders.paidPaise} > 0`))
    .returning({ id: orders.id });
  return { claimed: claimed.length };
}

/**
 * Guest lookup by order number + email (rate limited at the route). Returns a signed link; the
 * same generic error for "no such order" and "wrong email".
 */
export async function lookupOrder(ctx: AppContext, orderNumber: string, email: string): Promise<{ orderNumber: string; token: string }> {
  const order = await ctx.db.query.orders.findFirst({ where: and(eq(orders.orderNumber, orderNumber), eq(orders.email, email)) });
  if (!order) throw new AppError('NOT_FOUND', 'We couldn’t find an order with that number and email');
  return { orderNumber: order.orderNumber, token: signOrderToken(ctx, order.orderNumber) };
}
