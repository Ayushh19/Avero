/**
 * Allowed state transitions. See docs/STATE_MACHINES.md.
 * Services must call `assertTransition` before changing any status column.
 */

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAYMENT_FAILED',
  'EXPIRED',
  'PAID',
  'PAID_UNFULFILLABLE',
  'CONFIRMED',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'PAYMENT_FAILED', 'EXPIRED'],
  PAYMENT_FAILED: ['PENDING_PAYMENT', 'EXPIRED'],
  /**
   * EXPIRED is terminal with one exception: a payment the gateway reports as succeeded *after* the
   * order expired (late success). Only the payment webhook handler may make this transition
   * (enforced in apps/api `transitionOrder`); it then re-reserves stock → CONFIRMED, or goes
   * PAID_UNFULFILLABLE → CANCELLED with a full refund.
   */
  EXPIRED: ['PAID'],
  PAID: ['CONFIRMED', 'CANCELLED', 'PAID_UNFULFILLABLE'],
  PAID_UNFULFILLABLE: ['CANCELLED'],
  CONFIRMED: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

export const ORDER_ITEM_STATUSES = [
  'ACTIVE',
  'CANCELLED',
  'DELIVERED',
  'RETURN_REQUESTED',
  'RETURNED',
  'REFUNDED',
  'EXCHANGE_REQUESTED',
  'EXCHANGED',
] as const;
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

export const ORDER_ITEM_TRANSITIONS: Record<OrderItemStatus, readonly OrderItemStatus[]> = {
  ACTIVE: ['CANCELLED', 'DELIVERED'],
  CANCELLED: [],
  DELIVERED: ['RETURN_REQUESTED', 'EXCHANGE_REQUESTED'],
  RETURN_REQUESTED: ['RETURNED', 'DELIVERED'],
  RETURNED: ['REFUNDED'],
  REFUNDED: [],
  EXCHANGE_REQUESTED: ['EXCHANGED', 'DELIVERED'],
  EXCHANGED: [],
};

export const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  PENDING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const RETURN_STATUSES = [
  'REQUESTED',
  'PICKUP_SCHEDULED',
  'PICKED_UP',
  'RECEIVED',
  'INSPECTED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const RETURN_TRANSITIONS: Record<ReturnStatus, readonly ReturnStatus[]> = {
  REQUESTED: ['PICKUP_SCHEDULED', 'CANCELLED'],
  PICKUP_SCHEDULED: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['RECEIVED'],
  RECEIVED: ['INSPECTED'],
  INSPECTED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const REFUND_STATUSES = [
  'INITIATED',
  'PROCESSING',
  'FAILED',
  'FALLBACK_TO_POINTS',
  'COMPLETED',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const REFUND_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
  INITIATED: ['PROCESSING'],
  PROCESSING: ['COMPLETED', 'FAILED'],
  FAILED: ['PROCESSING', 'FALLBACK_TO_POINTS'],
  FALLBACK_TO_POINTS: ['COMPLETED'],
  COMPLETED: [],
};

export function canTransition<S extends string>(
  map: Record<S, readonly S[]>,
  from: S,
  to: S,
): boolean {
  return map[from].includes(to);
}
