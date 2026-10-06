import type { OrderStatus } from '@avero/shared';
import { and, eq } from 'drizzle-orm';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import type { Tx } from '../../db/client';
import { orderEvents, orders, shipments } from '../../db/schema';
import { enqueue } from '../../jobs/queue';
import { addDays, addHours } from '../../lib/clock';
import { randomCode } from '../../lib/crypto';
import { noticeTemplate } from '../../lib/email-templates';
import { AppError } from '../../lib/errors';
import { transitionOrder, transitionOrderItems, type OrderRow } from '../../lib/transitions';
import { estimateDelivery } from '../delivery/pincode';
import { scheduleConfirm } from '../loyalty/lifecycle';
import { notify } from '../notifications/service';
import { orderLink } from '../orders/access';

/**
 * Simulated fulfilment: CONFIRMED → PACKED → SHIPPED → OUT_FOR_DELIVERY → DELIVERED on realistic
 * dates on the simulated clock (they match the expected-delivery date the shopper was shown).
 * One `fulfilment.advance` job per step; the whole schedule is computed once at confirmation and
 * carried in the job payload. A step whose order has moved on (cancelled, or advanced from the dev
 * panel) is a no-op.
 */

export const FULFILMENT_STEPS = ['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const;
export type FulfilmentStep = (typeof FULFILMENT_STEPS)[number];
type Plan = Record<FulfilmentStep, string>;

export const CARRIER = 'BlueTrail Express (simulated)';
const WAREHOUSE = 'AVERO Fulfilment Centre, Bengaluru';
const REVIEW_PROMPT_DAYS = 3;

const PREVIOUS: Record<FulfilmentStep, OrderStatus> = {
  PACKED: 'CONFIRMED',
  SHIPPED: 'PACKED',
  OUT_FOR_DELIVERY: 'SHIPPED',
  DELIVERED: 'OUT_FOR_DELIVERY',
};

const istAt = (ymd: string, hour: number) => new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00+05:30`);
const atLeast = (d: Date, min: Date) => (d < min ? min : d);

/** Packed ~3 h after confirmation, dispatched next morning, delivered on the earliest promised day. */
export function planFor(order: OrderRow, confirmedAt: Date): Plan {
  const option = estimateDelivery(order.address.pincode, confirmedAt).options.find((o) => o.method === order.shippingMethod);
  const day = option?.earliest ?? (order.expectedDeliveryAt ?? addDays(confirmedAt, 5)).toISOString().slice(0, 10);
  const packed = addHours(confirmedAt, 3);
  const shipped = atLeast(addHours(confirmedAt, 18), addHours(packed, 1));
  const out = atLeast(istAt(day, 8), addHours(shipped, 1));
  const delivered = atLeast(istAt(day, 15), addHours(out, 1));
  return { PACKED: packed.toISOString(), SHIPPED: shipped.toISOString(), OUT_FOR_DELIVERY: out.toISOString(), DELIVERED: delivered.toISOString() };
}

/** Called in the transaction that confirms an order (or creates an exchange replacement). */
export async function scheduleFulfilment(ctx: AppContext, tx: Tx, order: OrderRow): Promise<void> {
  const plan = planFor(order, ctx.clock.now());
  await enqueueStep(tx, order.id, 'PACKED', plan);
}

async function enqueueStep(tx: Tx, orderId: string, to: FulfilmentStep, plan: Plan): Promise<void> {
  await enqueue(tx, 'fulfilment.advance', { orderId, to, plan }, { runAt: new Date(plan[to]), dedupeKey: `fulfilment:${orderId}:${to}` });
}

async function trackingEvent(tx: Tx, at: Date, orderId: string, shipmentId: string, status: string, description: string, location: string | null) {
  await tx.insert(orderEvents).values({ orderId, type: 'tracking', meta: { shipmentId, status, description, location }, occurredAt: at });
}

/**
 * Job `fulfilment.advance` (and the dev "advance" button with `force`). Moves the order one step if
 * it is still where the schedule expects, records tracking, notifies, and schedules the next step.
 */
export async function advanceFulfilment(ctx: AppContext, payload: { orderId: string; to: FulfilmentStep; plan: Plan }): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, payload.orderId)).for('update');
    if (!order || order.status !== PREVIOUS[payload.to]) return false;
    // A step processed late (e.g. after the dev clock jumped days ahead) happened at its scheduled time.
    const planned = new Date(payload.plan[payload.to]);
    const now = planned < ctx.clock.now() ? planned : ctx.clock.now();
    const city = order.address.city;
    const to = payload.to;
    const link = order.userId ? `/account/orders/${order.orderNumber}` : null;
    const href = orderLink(ctx, order);

    if (to === 'PACKED') {
      await transitionOrder(ctx, tx, order, 'PACKED', { event: 'order_packed', at: now });
      await notify(ctx, tx, { userId: order.userId, kind: 'order', title: `Order ${order.orderNumber} is packed`, body: 'It leaves our warehouse soon.', link });
    } else if (to === 'SHIPPED') {
      const [shipment] = await tx
        .insert(shipments)
        .values({ orderId: order.id, kind: 'forward', carrier: CARRIER, trackingNumber: `BT${randomCode(10)}`, status: 'in_transit' })
        .returning();
      await transitionOrder(ctx, tx, order, 'SHIPPED', { event: 'order_shipped', meta: { trackingNumber: shipment!.trackingNumber }, at: now });
      await trackingEvent(tx, now, order.id, shipment!.id, 'picked_up', 'Picked up by courier', WAREHOUSE);
      await notify(ctx, tx, {
        userId: order.userId,
        kind: 'order',
        title: `Order ${order.orderNumber} has shipped`,
        body: `${CARRIER} · ${shipment!.trackingNumber}`,
        link,
        email: noticeTemplate({
          to: order.email,
          template: 'order_shipped',
          subject: `Your order ${order.orderNumber} has shipped`,
          heading: 'Your order is on its way',
          paragraphs: [`Carrier: ${CARRIER}. Tracking number: ${shipment!.trackingNumber}.`],
          link: { href, label: 'Track your order' },
        }),
      });
    } else if (to === 'OUT_FOR_DELIVERY') {
      const shipment = await tx.query.shipments.findFirst({ where: and(eq(shipments.orderId, order.id), eq(shipments.kind, 'forward')) });
      await transitionOrder(ctx, tx, order, 'OUT_FOR_DELIVERY', { event: 'order_out_for_delivery', at: now });
      if (shipment) {
        await tx.update(shipments).set({ status: 'out_for_delivery' }).where(eq(shipments.id, shipment.id));
        await trackingEvent(tx, now, order.id, shipment.id, 'arrived', 'Arrived at delivery hub', `${city} hub`);
        await trackingEvent(tx, now, order.id, shipment.id, 'out_for_delivery', 'Out for delivery', city);
      }
      await notify(ctx, tx, {
        userId: order.userId,
        kind: 'order',
        title: `Order ${order.orderNumber} is out for delivery`,
        body: 'Arriving today.',
        link,
        email: noticeTemplate({
          to: order.email,
          template: 'order_out_for_delivery',
          subject: `Arriving today: order ${order.orderNumber}`,
          heading: 'Out for delivery',
          paragraphs: [`Your order is with the courier in ${city} and arrives today.`],
          link: { href, label: 'Track your order' },
        }),
      });
    } else {
      const shipment = await tx.query.shipments.findFirst({ where: and(eq(shipments.orderId, order.id), eq(shipments.kind, 'forward')) });
      const windowEnds = addDays(now, business.returnWindowDays);
      await transitionOrder(ctx, tx, order, 'DELIVERED', { event: 'order_delivered', set: { deliveredAt: now, returnWindowEndsAt: windowEnds }, at: now });
      await transitionOrderItems(ctx, tx, order.id, 'ACTIVE', 'DELIVERED', 'item_delivered', now);
      await scheduleConfirm(tx, order.id, windowEnds);
      if (order.userId) {
        await enqueue(tx, 'review.prompt', { orderId: order.id }, { runAt: addDays(now, REVIEW_PROMPT_DAYS), dedupeKey: `review-prompt:${order.id}` });
      }
      if (shipment) {
        await tx.update(shipments).set({ status: 'delivered' }).where(eq(shipments.id, shipment.id));
        await trackingEvent(tx, now, order.id, shipment.id, 'delivered', 'Delivered', city);
      }
      const until = windowEnds.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });
      await notify(ctx, tx, {
        userId: order.userId,
        kind: 'order',
        title: `Order ${order.orderNumber} was delivered`,
        body: order.kind === 'exchange' ? 'Your exchange has arrived.' : `Not quite right? Returns and exchanges are open until ${until}.`,
        link,
        email: noticeTemplate({
          to: order.email,
          template: 'order_delivered',
          subject: `Delivered: order ${order.orderNumber}`,
          heading: 'Your order was delivered',
          paragraphs: [
            'We hope you love them.',
            order.kind === 'exchange' ? '' : `If something isn’t right, you can return or exchange items until ${until}.`,
          ].filter(Boolean),
          link: { href, label: 'View your order' },
        }),
      });
    }

    const next = FULFILMENT_STEPS[FULFILMENT_STEPS.indexOf(to) + 1];
    if (next) await enqueueStep(tx, order.id, next, payload.plan);
    return true;
  });
}

/** Dev panel: perform the order's next fulfilment step now. */
export async function advanceNow(ctx: AppContext, orderNumber: string): Promise<OrderStatus> {
  const order = await ctx.db.query.orders.findFirst({ where: eq(orders.orderNumber, orderNumber.toUpperCase()) });
  if (!order) throw new AppError('NOT_FOUND', 'Order not found');
  const step = FULFILMENT_STEPS.find((s) => PREVIOUS[s] === order.status);
  if (!step) throw new AppError('INVALID_STATE_TRANSITION', `Order is ${order.status}; nothing to advance`);
  const confirmed = await ctx.db.query.orderEvents.findFirst({
    where: and(eq(orderEvents.orderId, order.id), eq(orderEvents.toStatus, 'CONFIRMED')),
  });
  const plan = planFor(order, confirmed?.occurredAt ?? ctx.clock.now());
  // Later steps keep their realistic times, but never earlier than now.
  const now = ctx.clock.now().toISOString();
  const adjusted = Object.fromEntries(FULFILMENT_STEPS.map((s) => [s, plan[s] < now ? now : plan[s]])) as Plan;
  await advanceFulfilment(ctx, { orderId: order.id, to: step, plan: adjusted });
  const after = await ctx.db.query.orders.findFirst({ where: eq(orders.id, order.id) });
  return after!.status;
}
