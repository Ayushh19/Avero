import {
  ORDER_ITEM_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
  RETURN_STATUSES,
} from '@avero/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { skus } from './catalog';
import { users } from './identity';
import { carts } from './shopping';

export interface AddressSnapshot {
  fullName: string;
  phone: string;
  line1: string;
  line2?: string | null;
  landmark?: string | null;
  city: string;
  state: string;
  pincode: string;
}

export const shippingMethod = pgEnum('shipping_method', ['standard', 'express']);

export const checkoutSessionStatus = pgEnum('checkout_session_status', [
  'open',
  'order_placed',
  'abandoned',
]);

export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    id: id(),
    cartId: uuid()
      .notNull()
      .references(() => carts.id),
    userId: uuid().references(() => users.id),
    email: text(),
    phone: text(),
    address: jsonb().$type<AddressSnapshot>(),
    shippingMethod: shippingMethod().notNull().default('standard'),
    couponCode: text(),
    pointsToRedeem: integer().notNull().default(0),
    quote: jsonb(),
    quoteHash: text(),
    quoteExpiresAt: ts(),
    status: checkoutSessionStatus().notNull().default('open'),
    /** "Buy now": the session buys only this SKU and ignores (and never trims) the bag. */
    buyNowSkuId: uuid().references(() => skus.id),
    buyNowQty: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('checkout_sessions_cart_idx').on(t.cartId),
    check(
      'checkout_sessions_buy_now_pair',
      sql`(${t.buyNowSkuId} IS NULL AND ${t.buyNowQty} IS NULL) OR (${t.buyNowSkuId} IS NOT NULL AND ${t.buyNowQty} > 0)`,
    ),
  ],
);

export const orderStatus = pgEnum('order_status', ORDER_STATUSES);
/** `exchange`: zero-value replacement order created by an exchange (no checkout, no payment). */
export const orderKind = pgEnum('order_kind', ['sale', 'exchange']);
export const orderItemStatus = pgEnum('order_item_status', ORDER_ITEM_STATUSES);

export const orders = pgTable(
  'orders',
  {
    id: id(),
    orderNumber: text().notNull().unique(),
    userId: uuid().references(() => users.id),
    /** Null only for exchange replacement orders. */
    checkoutSessionId: uuid()
      .unique()
      .references(() => checkoutSessions.id),
    kind: orderKind().notNull().default('sale'),
    parentOrderId: uuid().references((): AnyPgColumn => orders.id),
    email: text().notNull(),
    phone: text().notNull(),
    status: orderStatus().notNull().default('PENDING_PAYMENT'),
    address: jsonb().$type<AddressSnapshot>().notNull(),
    shippingMethod: shippingMethod().notNull(),
    subtotalPaise: integer().notNull(),
    discountPaise: integer().notNull().default(0),
    shippingPaise: integer().notNull().default(0),
    pointsDiscountPaise: integer().notNull().default(0),
    pointsRedeemed: integer().notNull().default(0),
    totalPaise: integer().notNull(),
    /** GST included in totalPaise (informational). */
    taxPaise: integer().notNull().default(0),
    couponCode: text(),
    paidPaise: integer().notNull().default(0),
    refundedPaise: integer().notNull().default(0),
    guestTokenHash: text(),
    reservationExpiresAt: ts(),
    placedAt: ts().notNull().defaultNow(),
    expectedDeliveryAt: ts(),
    deliveredAt: ts(),
    returnWindowEndsAt: ts(),
    cancelledAt: ts(),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('orders_user_idx').on(t.userId, t.placedAt),
    index('orders_email_idx').on(t.email),
    index('orders_status_idx').on(t.status),
    check('orders_refund_lte_paid', sql`${t.refundedPaise} <= ${t.paidPaise}`),
    check('orders_amounts_nonneg', sql`${t.totalPaise} >= 0 AND ${t.paidPaise} >= 0 AND ${t.refundedPaise} >= 0`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    skuId: uuid()
      .notNull()
      .references(() => skus.id),
    // snapshots
    productId: uuid().notNull(),
    productName: text().notNull(),
    productSlug: text().notNull(),
    colorwayId: uuid().notNull(),
    colorwayName: text().notNull(),
    colorwaySlug: text().notNull(),
    sizeLabel: text().notNull(),
    skuCode: text().notNull(),
    imageUrl: text(),
    isFinalSale: boolean().notNull().default(false),
    // money
    unitPricePaise: integer().notNull(),
    mrpPaise: integer().notNull(),
    qty: integer().notNull(),
    /** Allocated share of order-level coupon discount. */
    discountPaise: integer().notNull().default(0),
    /** Allocated share of points redemption. */
    pointsDiscountPaise: integer().notNull().default(0),
    totalPaise: integer().notNull(),
    gstRateBps: integer().notNull(),
    status: orderItemStatus().notNull().default('ACTIVE'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('order_items_order_idx').on(t.orderId),
    check('order_items_qty_positive', sql`${t.qty} > 0`),
  ],
);

export const orderEvents = pgTable(
  'order_events',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    orderItemId: uuid().references(() => orderItems.id),
    type: text().notNull(),
    fromStatus: text(),
    toStatus: text(),
    meta: jsonb().$type<Record<string, unknown>>(),
    occurredAt: ts().notNull().defaultNow(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId, t.occurredAt)],
);

export const shipmentKind = pgEnum('shipment_kind', ['forward', 'return_pickup', 'exchange']);

export const shipments = pgTable(
  'shipments',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    kind: shipmentKind().notNull().default('forward'),
    carrier: text().notNull(),
    trackingNumber: text().notNull().unique(),
    status: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('shipments_order_idx').on(t.orderId)],
);

export const paymentStatus = pgEnum('payment_status', PAYMENT_STATUSES);
export const paymentMethod = pgEnum('payment_method', ['upi', 'card', 'netbanking']);

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    amountPaise: integer().notNull(),
    method: paymentMethod().notNull(),
    status: paymentStatus().notNull().default('CREATED'),
    scenario: text(),
    failureReason: text(),
    gatewayRef: text().notNull().unique(),
    idempotencyKey: text().notNull().unique(),
    expiresAt: ts().notNull(),
    settledAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('payment_attempts_order_idx').on(t.orderId),
    uniqueIndex('payment_attempts_one_success_uq')
      .on(t.orderId)
      .where(sql`${t.status} = 'SUCCEEDED'`),
  ],
);

export const paymentEvents = pgTable('payment_events', {
  id: id(),
  eventId: text().notNull().unique(),
  attemptId: uuid()
    .notNull()
    .references(() => paymentAttempts.id),
  type: text().notNull(),
  payload: jsonb().notNull(),
  receivedAt: ts().notNull().defaultNow(),
  processedAt: ts(),
});

export const returnStatus = pgEnum('return_status', RETURN_STATUSES);
export const returnKind = pgEnum('return_kind', ['return', 'exchange']);
export const refundDestination = pgEnum('refund_destination', ['original', 'points']);

export const returnRequests = pgTable(
  'return_requests',
  {
    id: id(),
    rmaNumber: text().notNull().unique(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    userId: uuid().references(() => users.id),
    kind: returnKind().notNull(),
    status: returnStatus().notNull().default('REQUESTED'),
    refundDestination: refundDestination().notNull().default('original'),
    replacementOrderId: uuid().references(() => orders.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('return_requests_order_idx').on(t.orderId)],
);

export const returnItems = pgTable(
  'return_items',
  {
    id: id(),
    returnRequestId: uuid()
      .notNull()
      .references(() => returnRequests.id, { onDelete: 'cascade' }),
    orderItemId: uuid()
      .notNull()
      .references(() => orderItems.id),
    qty: integer().notNull(),
    reason: text().notNull(),
    comment: text(),
    exchangeSkuId: uuid().references(() => skus.id),
  },
  (t) => [uniqueIndex('return_items_order_item_uq').on(t.returnRequestId, t.orderItemId)],
);

export const refundStatus = pgEnum('refund_status', REFUND_STATUSES);

export const refunds = pgTable(
  'refunds',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    returnRequestId: uuid().references(() => returnRequests.id),
    amountPaise: integer().notNull(),
    pointsAmount: integer().notNull().default(0),
    destination: refundDestination().notNull().default('original'),
    status: refundStatus().notNull().default('INITIATED'),
    attempts: integer().notNull().default(0),
    failureReason: text(),
    idempotencyKey: text().notNull().unique(),
    /** cancellation | return | unfulfillable | duplicate_capture */
    reason: text().notNull().default('other'),
    /** The capture being refunded (defaults to the order's succeeded attempt). */
    paymentAttemptId: uuid().references(() => paymentAttempts.id),
    completedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('refunds_order_idx').on(t.orderId),
    check('refunds_amount_nonneg', sql`${t.amountPaise} >= 0`),
  ],
);

/**
 * State of the *simulated third-party gateway* (modules/payments/gateway-sim). Kept apart from
 * our payment tables on purpose: our side only learns outcomes via signed webhooks or by asking
 * the gateway during reconciliation, exactly as with a real provider.
 */
export const gatewaySimChargeStatus = pgEnum('gateway_sim_charge_status', [
  'created',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

export const gatewaySimCharges = pgTable('gateway_sim_charges', {
  id: id(),
  gatewayRef: text().notNull().unique(),
  merchantReference: text().notNull(),
  amountPaise: integer().notNull(),
  method: paymentMethod().notNull(),
  status: gatewaySimChargeStatus().notNull().default('created'),
  scenario: text(),
  failureReason: text(),
  /** When the gateway will settle a submitted charge (null: never, e.g. `timeout`). */
  resolveAt: ts(),
  /** For `late_success`: the merchant's reservation expiry the simulation should overshoot. */
  lateAfter: ts(),
  expiresAt: ts().notNull(),
  submittedAt: ts(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Simulated gateway: knobs for exercising refund failures (single row, id = 1). */
export const gatewaySimSettings = pgTable('gateway_sim_settings', {
  id: integer().primaryKey(),
  refundFailuresRemaining: integer().notNull().default(0),
});

/** Simulated gateway: refund requests it has answered, keyed by the merchant's idempotency key. */
export const gatewaySimRefunds = pgTable('gateway_sim_refunds', {
  id: id(),
  requestKey: text().notNull().unique(),
  gatewayRef: text().notNull(),
  amountPaise: integer().notNull(),
  status: text().$type<'succeeded' | 'failed'>().notNull(),
  failureReason: text(),
  createdAt: createdAt(),
});
