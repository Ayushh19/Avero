import {
  formatINR,
  type CreateReturnInput,
  type ExchangeOptionDto,
  type ReturnDto,
  type ReturnOptionsDto,
  type ReturnStatus,
  type ReturnSummaryDto,
} from '@avero/shared';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { uuidv7 } from 'uuidv7';
import type { AppContext } from '../../context';
import type { DbOrTx, Tx } from '../../db/client';
import {
  colorwayImages,
  colorways,
  orderEvents,
  orderItems,
  orders,
  products,
  refunds,
  returnItems,
  returnRequests,
  shipments,
  skus,
} from '../../db/schema';
import { enqueue } from '../../jobs/queue';
import { addDays } from '../../lib/clock';
import { randomCode } from '../../lib/crypto';
import { noticeTemplate } from '../../lib/email-templates';
import { AppError } from '../../lib/errors';
import { transitionItems, transitionReturn, type OrderRow, type ReturnRow } from '../../lib/transitions';
import { orderNumber } from '../checkout/service';
import { estimateDelivery } from '../delivery/pincode';
import { CARRIER, scheduleFulfilment } from '../fulfilment/service';
import { commitReturnReservations, releaseReturnReservations, reserveForReturn } from '../inventory/reservations';
import { adjustPendingEarn } from '../loyalty/points';
import { notify } from '../notifications/service';
import { canAccessOrder, orderLink } from '../orders/access';
import { pointsToReturn, restock } from '../orders/cancellation';
import { createRefund, toRefundDto } from '../refunds/service';

/**
 * Returns & exchanges (docs/BUSINESS_RULES.md 23–25). Approval is automatic: a valid request goes
 * straight to PICKUP_SCHEDULED. The courier side is simulated on realistic dates by
 * `return.advance` jobs: PICKED_UP (next day) → RECEIVED (+2 days) → INSPECTED (+1 day, always
 * passes) → COMPLETED. Returns end in a refund; exchanges in a zero-value replacement order.
 * Whole lines only.
 */

type ItemRow = typeof orderItems.$inferSelect;
const STEPS = ['PICKED_UP', 'RECEIVED', 'INSPECTED'] as const;
type Step = (typeof STEPS)[number];
const PREVIOUS: Record<Step, ReturnStatus> = { PICKED_UP: 'PICKUP_SCHEDULED', RECEIVED: 'PICKED_UP', INSPECTED: 'RECEIVED' };

const istDay = (d: Date, plusDays: number, hour: number) => {
  const ymd = new Date(d.getTime() + 330 * 60_000 + plusDays * 86_400_000).toISOString().slice(0, 10);
  return new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00+05:30`);
};
const dateText = (d: Date) => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });

/* ---------------- eligibility ---------------- */

function ineligibleReason(ctx: AppContext, order: OrderRow, item: ItemRow): string | null {
  if (order.kind === 'exchange') return 'Items received in an exchange can’t be returned again';
  switch (item.status) {
    case 'ACTIVE':
      return 'Not delivered yet';
    case 'CANCELLED':
      return 'Cancelled';
    case 'RETURN_REQUESTED':
    case 'EXCHANGE_REQUESTED':
      return 'A return or exchange is already in progress';
    case 'RETURNED':
    case 'REFUNDED':
      return 'Already returned';
    case 'EXCHANGED':
      return 'Already exchanged';
  }
  if (item.isFinalSale) return 'Final-sale items can’t be returned';
  if (!order.returnWindowEndsAt || order.returnWindowEndsAt < ctx.clock.now()) {
    return order.returnWindowEndsAt ? `Return window closed on ${dateText(order.returnWindowEndsAt)}` : 'Not delivered yet';
  }
  return null;
}

/** Same product, same price as paid, any other size/colour that's for sale. */
async function exchangeOptions(db: DbOrTx, item: ItemRow): Promise<ExchangeOptionDto[]> {
  const rows = await db
    .select({ sku: skus, colorway: colorways })
    .from(skus)
    .innerJoin(colorways, eq(colorways.id, skus.colorwayId))
    .innerJoin(products, eq(products.id, colorways.productId))
    .where(
      and(
        eq(products.id, item.productId),
        eq(products.status, 'active'),
        eq(colorways.status, 'active'),
        eq(skus.status, 'active'),
        eq(skus.pricePaise, item.unitPricePaise),
        ne(skus.id, item.skuId),
      ),
    )
    .orderBy(asc(colorways.name), asc(skus.sizeSort));
  return rows.map((r) => ({
    skuId: r.sku.id,
    colorwayId: r.colorway.id,
    colorName: r.colorway.name,
    sizeLabel: r.sku.sizeLabel,
    available: r.sku.onHand - r.sku.reserved >= item.qty,
  }));
}

async function accessibleOrder(ctx: AppContext, req: FastifyRequest, orderNumberRaw: string, token?: string): Promise<OrderRow> {
  const order = await ctx.db.query.orders.findFirst({ where: eq(orders.orderNumber, orderNumberRaw.toUpperCase()) });
  if (!order || !canAccessOrder(ctx, req, order, token)) throw new AppError('NOT_FOUND', 'Order not found');
  return order;
}

export async function returnOptions(ctx: AppContext, req: FastifyRequest, orderNumberRaw: string, token?: string): Promise<ReturnOptionsDto> {
  const order = await accessibleOrder(ctx, req, orderNumberRaw, token);
  const items = await ctx.db.query.orderItems.findMany({ where: eq(orderItems.orderId, order.id), orderBy: asc(orderItems.createdAt) });
  return {
    orderNumber: order.orderNumber,
    windowEndsAt: order.returnWindowEndsAt?.toISOString() ?? null,
    windowOpen: Boolean(order.returnWindowEndsAt && order.returnWindowEndsAt >= ctx.clock.now()),
    pointsRefundAllowed: order.userId !== null,
    items: await Promise.all(
      items.map(async (i) => {
        const reason = ineligibleReason(ctx, order, i);
        return {
          orderItemId: i.id,
          productName: i.productName,
          colorName: i.colorwayName,
          sizeLabel: i.sizeLabel,
          imageUrl: i.imageUrl,
          qty: i.qty,
          totalPaise: i.totalPaise,
          returnable: reason === null,
          reason,
          exchangeOptions: reason === null ? await exchangeOptions(ctx.db, i) : [],
        };
      }),
    ),
  };
}

export function canReturnAny(ctx: AppContext, order: OrderRow, items: ItemRow[]): boolean {
  return items.some((i) => ineligibleReason(ctx, order, i) === null);
}

/* ---------------- create ---------------- */

export async function createReturn(ctx: AppContext, req: FastifyRequest, input: CreateReturnInput, token?: string): Promise<ReturnRow> {
  const found = await accessibleOrder(ctx, req, input.orderNumber, token);
  const ids = input.items.map((i) => i.orderItemId);
  if (new Set(ids).size !== ids.length) throw new AppError('VALIDATION_FAILED', 'Each item can only be listed once');

  const ret = await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, found.id)).for('update');
    if (!order) throw new AppError('NOT_FOUND', 'Order not found');
    if (input.refundDestination === 'points' && !order.userId) {
      throw new AppError('VALIDATION_FAILED', 'Refunds as points need an AVERO account. Choose your original payment method.');
    }
    const items = await tx.query.orderItems.findMany({ where: and(eq(orderItems.orderId, order.id), inArray(orderItems.id, ids)) });
    if (items.length !== ids.length) throw new AppError('NOT_FOUND', 'Some items aren’t part of this order');
    for (const item of items) {
      const why = ineligibleReason(ctx, order, item);
      if (why) {
        const closed = why.startsWith('Return window closed');
        throw new AppError(closed ? 'RETURN_WINDOW_CLOSED' : 'RETURN_NOT_ELIGIBLE', `${item.productName} (UK ${item.sizeLabel}): ${why}`, {
          orderItemId: item.id,
        });
      }
    }

    const now = ctx.clock.now();
    const yymm = orderNumber(now).slice(3, 7);
    let rma = `RMA-${yymm}-${randomCode(5)}`;
    while (await tx.query.returnRequests.findFirst({ where: eq(returnRequests.rmaNumber, rma), columns: { id: true } })) rma = `RMA-${yymm}-${randomCode(5)}`;
    const [created] = await tx
      .insert(returnRequests)
      .values({ rmaNumber: rma, orderId: order.id, userId: order.userId, kind: input.kind, refundDestination: input.refundDestination, createdAt: now })
      .returning();

    for (const line of input.items) {
      const item = items.find((i) => i.id === line.orderItemId)!;
      if (input.kind === 'exchange') {
        const option = (await exchangeOptions(tx, item)).find((o) => o.skuId === line.exchangeSkuId);
        if (!option) throw new AppError('EXCHANGE_UNAVAILABLE', `That size or colour isn’t available as an exchange for ${item.productName}`);
        if (!(await reserveForReturn(tx, created!.id, option.skuId, item.qty))) {
          throw new AppError('EXCHANGE_UNAVAILABLE', `${option.colorName} UK ${option.sizeLabel} just sold out. You can return the item instead.`, {
            orderItemId: item.id,
          });
        }
      }
      await tx.insert(returnItems).values({
        returnRequestId: created!.id,
        orderItemId: item.id,
        qty: item.qty,
        reason: line.reason,
        comment: line.comment ?? null,
        exchangeSkuId: input.kind === 'exchange' ? line.exchangeSkuId! : null,
      });
    }
    await transitionItems(
      ctx,
      tx,
      order.id,
      ids,
      'DELIVERED',
      input.kind === 'exchange' ? 'EXCHANGE_REQUESTED' : 'RETURN_REQUESTED',
      input.kind === 'exchange' ? 'item_exchange_requested' : 'item_return_requested',
      { rmaNumber: rma },
    );
    await tx.insert(orderEvents).values({
      orderId: order.id,
      type: 'return_status',
      toStatus: 'REQUESTED',
      meta: { rmaNumber: rma, kind: input.kind },
      occurredAt: now,
    });

    // Automatic approval: book the pickup for tomorrow.
    const pickupAt = istDay(now, 1, 11);
    const [shipment] = await tx
      .insert(shipments)
      .values({ orderId: order.id, kind: 'return_pickup', carrier: CARRIER, trackingNumber: `BR${randomCode(10)}`, status: 'pickup_scheduled' })
      .returning();
    const scheduled = await transitionReturn(ctx, tx, created!, 'PICKUP_SCHEDULED');
    await enqueue(tx, 'return.advance', { returnId: created!.id, to: 'PICKED_UP' }, { runAt: pickupAt, dedupeKey: `return:${created!.id}:PICKED_UP` });

    const noun = input.kind === 'exchange' ? 'Exchange' : 'Return';
    await notify(ctx, tx, {
      userId: order.userId,
      kind: 'return',
      title: `${noun} ${rma}: pickup ${dateText(pickupAt)}`,
      body: `${items.length} ${items.length === 1 ? 'item' : 'items'} from order ${order.orderNumber}. Keep the shoes in their box with tags attached.`,
      link: order.userId ? `/account/returns/${rma}` : null,
      email: noticeTemplate({
        to: order.email,
        template: 'return_requested',
        subject: `${noun} ${rma}: pickup booked`,
        heading: `${noun} requested`,
        paragraphs: [
          `Our courier will collect ${items.map((i) => `${i.productName} (UK ${i.sizeLabel})`).join(', ')} on ${dateText(pickupAt)}. Pickup reference: ${shipment!.trackingNumber}.`,
          input.kind === 'exchange'
            ? 'We’ve set your replacement aside and will send it once the original passes inspection.'
            : 'Your refund starts as soon as the item passes inspection.',
        ],
        link: { href: orderLink(ctx, order), label: 'View your order' },
      }),
    });
    return scheduled;
  });

  ctx.catalog.invalidate();
  return ret;
}

/* ---------------- lifecycle ---------------- */

/** Job `return.advance` (and the dev "advance" button). */
export async function advanceReturn(ctx: AppContext, payload: { returnId: string; to: Step }): Promise<boolean> {
  const changed = await ctx.db.transaction(async (tx) => {
    const [ret] = await tx.select().from(returnRequests).where(eq(returnRequests.id, payload.returnId)).for('update');
    if (!ret || ret.status !== PREVIOUS[payload.to]) return false;
    const [order] = await tx.select().from(orders).where(eq(orders.id, ret.orderId)).for('update');
    const now = ctx.clock.now();
    const pickup = await tx.query.shipments.findFirst({ where: and(eq(shipments.orderId, ret.orderId), eq(shipments.kind, 'return_pickup')), orderBy: desc(shipments.createdAt) });

    if (payload.to === 'PICKED_UP') {
      await transitionReturn(ctx, tx, ret, 'PICKED_UP');
      if (pickup) await tx.update(shipments).set({ status: 'in_transit' }).where(eq(shipments.id, pickup.id));
      await enqueue(tx, 'return.advance', { returnId: ret.id, to: 'RECEIVED' }, { runAt: istDay(now, 2, 10), dedupeKey: `return:${ret.id}:RECEIVED` });
      await notify(ctx, tx, {
        userId: order!.userId,
        kind: 'return',
        title: `${ret.rmaNumber}: picked up`,
        body: 'Your parcel is on its way back to us.',
        link: order!.userId ? `/account/returns/${ret.rmaNumber}` : null,
      });
      return true;
    }
    if (payload.to === 'RECEIVED') {
      await transitionReturn(ctx, tx, ret, 'RECEIVED');
      if (pickup) await tx.update(shipments).set({ status: 'delivered' }).where(eq(shipments.id, pickup.id));
      await enqueue(tx, 'return.advance', { returnId: ret.id, to: 'INSPECTED' }, { runAt: istDay(now, 1, 12), dedupeKey: `return:${ret.id}:INSPECTED` });
      return true;
    }
    await complete(ctx, tx, ret, order!);
    return true;
  });
  if (changed) ctx.catalog.invalidate();
  return changed;
}

/** INSPECTED (auto-pass) → restock → refund (return) or replacement order (exchange) → COMPLETED. */
async function complete(ctx: AppContext, tx: Tx, ret: ReturnRow, order: OrderRow): Promise<void> {
  const inspected = await transitionReturn(ctx, tx, ret, 'INSPECTED');
  const lines = await tx.query.returnItems.findMany({ where: eq(returnItems.returnRequestId, ret.id) });
  const items = await tx.query.orderItems.findMany({ where: inArray(orderItems.id, lines.map((l) => l.orderItemId)) });
  await restock(tx, items, 'restock_return');
  const ids = items.map((i) => i.id);
  const link = order.userId ? `/account/returns/${ret.rmaNumber}` : null;

  if (ret.kind === 'exchange') {
    const replacement = await createReplacementOrder(ctx, tx, ret, order, items, lines);
    await transitionItems(ctx, tx, order.id, ids, 'EXCHANGE_REQUESTED', 'EXCHANGED', 'item_exchanged', { rmaNumber: ret.rmaNumber, replacementOrderNumber: replacement.orderNumber });
    await transitionReturn(ctx, tx, inspected, 'COMPLETED', { replacementOrderId: replacement.id });
    await notify(ctx, tx, {
      userId: order.userId,
      kind: 'return',
      title: `${ret.rmaNumber}: exchange on its way`,
      body: `Replacement order ${replacement.orderNumber} has been created and ships soon.`,
      link,
      email: noticeTemplate({
        to: order.email,
        template: 'exchange_completed',
        subject: `Your exchange ${ret.rmaNumber} is on its way`,
        heading: 'Your exchange is on its way',
        paragraphs: [`Your return passed inspection. We’ve created replacement order ${replacement.orderNumber} at no cost and will email you when it ships.`],
        link: { href: orderLink(ctx, replacement), label: 'View replacement order' },
      }),
    });
    return;
  }

  await transitionItems(ctx, tx, order.id, ids, 'RETURN_REQUESTED', 'RETURNED', 'item_returned', { rmaNumber: ret.rmaNumber });
  const remaining = (await tx.query.orderItems.findMany({ where: eq(orderItems.orderId, order.id) })).filter(
    (i) => !['CANCELLED', 'RETURNED', 'REFUNDED'].includes(i.status),
  );
  const amount = items.reduce((s, i) => s + i.totalPaise, 0);
  const points = await pointsToReturn(tx, order, items, remaining.length === 0);
  await createRefund(ctx, tx, {
    order,
    amountPaise: amount,
    pointsToReturn: points,
    destination: ret.refundDestination,
    reason: 'return',
    key: `return:${ret.id}`,
    returnRequestId: ret.id,
  });
  await adjustPendingEarn(tx, order);
  await transitionReturn(ctx, tx, inspected, 'COMPLETED');
  await notify(ctx, tx, {
    userId: order.userId,
    kind: 'return',
    title: `${ret.rmaNumber}: return accepted`,
    body: ret.refundDestination === 'points' ? `${formatINR(amount)} is being added as AVERO points.` : `A refund of ${formatINR(amount)} is on its way.`,
    link,
  });
}

async function createReplacementOrder(
  ctx: AppContext,
  tx: Tx,
  ret: ReturnRow,
  parent: OrderRow,
  items: ItemRow[],
  lines: (typeof returnItems.$inferSelect)[],
): Promise<OrderRow> {
  const now = ctx.clock.now();
  let number = orderNumber(now);
  while (await tx.query.orders.findFirst({ where: eq(orders.orderNumber, number), columns: { id: true } })) number = orderNumber(now);
  const option = estimateDelivery(parent.address.pincode, now).options.find((o) => o.method === 'standard');
  const id = uuidv7();
  const [replacement] = await tx
    .insert(orders)
    .values({
      id,
      orderNumber: number,
      userId: parent.userId,
      checkoutSessionId: null,
      kind: 'exchange',
      parentOrderId: parent.id,
      email: parent.email,
      phone: parent.phone,
      status: 'CONFIRMED',
      address: parent.address,
      shippingMethod: 'standard',
      subtotalPaise: 0,
      totalPaise: 0,
      guestTokenHash: parent.guestTokenHash,
      placedAt: now,
      expectedDeliveryAt: option ? new Date(`${option.latest}T12:30:00Z`) : addDays(now, 6),
    })
    .returning();

  for (const line of lines) {
    const original = items.find((i) => i.id === line.orderItemId)!;
    const [target] = await tx
      .select({ sku: skus, colorway: colorways, product: products })
      .from(skus)
      .innerJoin(colorways, eq(colorways.id, skus.colorwayId))
      .innerJoin(products, eq(products.id, colorways.productId))
      .where(eq(skus.id, line.exchangeSkuId!));
    const image = await tx.query.colorwayImages.findFirst({
      where: and(eq(colorwayImages.colorwayId, target!.colorway.id), eq(colorwayImages.position, 0)),
    });
    await tx.insert(orderItems).values({
      orderId: id,
      skuId: target!.sku.id,
      productId: target!.product.id,
      productName: target!.product.name,
      productSlug: target!.product.slug,
      colorwayId: target!.colorway.id,
      colorwayName: target!.colorway.name,
      colorwaySlug: target!.colorway.slug,
      sizeLabel: target!.sku.sizeLabel,
      skuCode: target!.sku.skuCode,
      imageUrl: image?.thumbUrl ?? image?.url ?? null,
      isFinalSale: target!.product.isFinalSale,
      unitPricePaise: original.unitPricePaise,
      mrpPaise: target!.sku.mrpPaise,
      qty: original.qty,
      totalPaise: 0,
      gstRateBps: original.gstRateBps,
    });
  }
  await commitReturnReservations(ctx, tx, ret.id);
  await tx.insert(orderEvents).values({
    orderId: id,
    type: 'exchange_order_created',
    toStatus: 'CONFIRMED',
    meta: { rmaNumber: ret.rmaNumber, parentOrderNumber: parent.orderNumber },
    occurredAt: now,
  });
  await scheduleFulfilment(ctx, tx, replacement!);
  return replacement!;
}

/** Shopper withdraws the request before the courier collects it. */
export async function cancelReturn(ctx: AppContext, req: FastifyRequest, rma: string, token?: string): Promise<ReturnRow> {
  const ret = await accessibleReturn(ctx, req, rma, token);
  const result = await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(returnRequests).where(eq(returnRequests.id, ret.id)).for('update');
    if (!locked || !['REQUESTED', 'PICKUP_SCHEDULED'].includes(locked.status)) {
      throw new AppError('CONFLICT', 'This return has already been picked up, so it can’t be cancelled');
    }
    const lines = await tx.query.returnItems.findMany({ where: eq(returnItems.returnRequestId, locked.id) });
    const cancelled = await transitionReturn(ctx, tx, locked, 'CANCELLED');
    await transitionItems(
      ctx,
      tx,
      locked.orderId,
      lines.map((l) => l.orderItemId),
      locked.kind === 'exchange' ? 'EXCHANGE_REQUESTED' : 'RETURN_REQUESTED',
      'DELIVERED',
      'item_return_cancelled',
      { rmaNumber: locked.rmaNumber },
    );
    await releaseReturnReservations(ctx, tx, locked.id);
    await tx
      .update(shipments)
      .set({ status: 'cancelled' })
      .where(and(eq(shipments.orderId, locked.orderId), eq(shipments.kind, 'return_pickup'), eq(shipments.status, 'pickup_scheduled')));
    return cancelled;
  });
  ctx.catalog.invalidate();
  return result;
}

/** Dev panel: perform the return's next step now. */
export async function advanceReturnNow(ctx: AppContext, rma: string): Promise<ReturnStatus> {
  const ret = await ctx.db.query.returnRequests.findFirst({ where: eq(returnRequests.rmaNumber, rma.toUpperCase()) });
  if (!ret) throw new AppError('NOT_FOUND', 'Return not found');
  const step = STEPS.find((s) => PREVIOUS[s] === ret.status);
  if (!step) throw new AppError('INVALID_STATE_TRANSITION', `Return is ${ret.status}; nothing to advance`);
  await advanceReturn(ctx, { returnId: ret.id, to: step });
  return (await ctx.db.query.returnRequests.findFirst({ where: eq(returnRequests.id, ret.id) }))!.status;
}

/* ---------------- reads ---------------- */

async function accessibleReturn(ctx: AppContext, req: FastifyRequest, rma: string, token?: string): Promise<ReturnRow> {
  const ret = await ctx.db.query.returnRequests.findFirst({ where: eq(returnRequests.rmaNumber, rma.toUpperCase()) });
  const order = ret && (await ctx.db.query.orders.findFirst({ where: eq(orders.id, ret.orderId) }));
  if (!ret || !order || !canAccessOrder(ctx, req, order, token)) throw new AppError('NOT_FOUND', 'Return not found');
  return ret;
}

export async function toReturnDto(ctx: AppContext, ret: ReturnRow): Promise<ReturnDto> {
  const order = (await ctx.db.query.orders.findFirst({ where: eq(orders.id, ret.orderId) }))!;
  const lines = await ctx.db.query.returnItems.findMany({ where: eq(returnItems.returnRequestId, ret.id) });
  const items = await ctx.db.query.orderItems.findMany({ where: inArray(orderItems.id, lines.map((l) => l.orderItemId)) });
  const targets = lines.some((l) => l.exchangeSkuId)
    ? await ctx.db
        .select({ id: skus.id, sizeLabel: skus.sizeLabel, colorName: colorways.name })
        .from(skus)
        .innerJoin(colorways, eq(colorways.id, skus.colorwayId))
        .where(inArray(skus.id, lines.map((l) => l.exchangeSkuId).filter((x): x is string => Boolean(x))))
    : [];
  const refund = await ctx.db.query.refunds.findFirst({ where: eq(refunds.returnRequestId, ret.id) });
  const replacement = ret.replacementOrderId ? await ctx.db.query.orders.findFirst({ where: eq(orders.id, ret.replacementOrderId) }) : null;
  const events = await ctx.db.query.orderEvents.findMany({ where: and(eq(orderEvents.orderId, ret.orderId), eq(orderEvents.type, 'return_status')), orderBy: asc(orderEvents.occurredAt) });
  return {
    rmaNumber: ret.rmaNumber,
    orderNumber: order.orderNumber,
    kind: ret.kind,
    status: ret.status,
    refundDestination: ret.refundDestination,
    createdAt: ret.createdAt.toISOString(),
    items: lines.map((l) => {
      const i = items.find((x) => x.id === l.orderItemId)!;
      const t = targets.find((x) => x.id === l.exchangeSkuId);
      return {
        orderItemId: i.id,
        productName: i.productName,
        colorName: i.colorwayName,
        sizeLabel: i.sizeLabel,
        imageUrl: i.imageUrl,
        qty: l.qty,
        totalPaise: i.totalPaise,
        reason: l.reason,
        comment: l.comment,
        exchangeFor: t ? { colorName: t.colorName, sizeLabel: t.sizeLabel } : null,
      };
    }),
    refundPaise: ret.kind === 'return' ? items.reduce((s, i) => s + i.totalPaise, 0) : 0,
    refund: refund ? toRefundDto(refund) : null,
    replacementOrderNumber: replacement?.orderNumber ?? null,
    canCancel: ['REQUESTED', 'PICKUP_SCHEDULED'].includes(ret.status),
    timeline: events
      .filter((e) => (e.meta as { rmaNumber?: string } | null)?.rmaNumber === ret.rmaNumber && e.toStatus)
      .map((e) => ({ status: e.toStatus as ReturnStatus, at: e.occurredAt.toISOString() })),
  };
}

export async function getReturn(ctx: AppContext, req: FastifyRequest, rma: string, token?: string): Promise<ReturnDto> {
  return toReturnDto(ctx, await accessibleReturn(ctx, req, rma, token));
}

export async function returnSummaries(db: DbOrTx, where: { userId: string } | { orderId: string }): Promise<ReturnSummaryDto[]> {
  const rows = await db
    .select({ ret: returnRequests, orderNumber: orders.orderNumber })
    .from(returnRequests)
    .innerJoin(orders, eq(orders.id, returnRequests.orderId))
    .where('userId' in where ? eq(returnRequests.userId, where.userId) : eq(returnRequests.orderId, where.orderId))
    .orderBy(desc(returnRequests.createdAt));
  const counts = rows.length
    ? await db.query.returnItems.findMany({ where: inArray(returnItems.returnRequestId, rows.map((r) => r.ret.id)) })
    : [];
  return rows.map(({ ret, orderNumber: number }) => ({
    rmaNumber: ret.rmaNumber,
    orderNumber: number,
    kind: ret.kind,
    status: ret.status,
    createdAt: ret.createdAt.toISOString(),
    itemCount: counts.filter((c) => c.returnRequestId === ret.id).length,
  }));
}
