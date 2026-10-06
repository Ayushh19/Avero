import type { OrderDto, OrderListDto, OrderStatus, RefundDto, ReturnStatus } from '@avero/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TimelineStep } from '../../components/ui/Nav';
import { api } from '../../lib/api';
import { useIntentKey } from '../checkout/hooks';

export const withToken = (path: string, token?: string | null) => (token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path);

export const ordersKey = ['orders'] as const;

export function useOrder(orderNumber: string | undefined, token?: string | null) {
  return useQuery({
    queryKey: ['orders', orderNumber, token ?? null],
    queryFn: ({ signal }) =>
      api.get<{ order: OrderDto }>(withToken(`/orders/${orderNumber}`, token), signal),
    select: (d) => d.order,
    enabled: Boolean(orderNumber),
    retry: false,
  });
}

export function useOrders() {
  return useQuery({
    queryKey: ordersKey,
    queryFn: ({ signal }) => api.get<OrderListDto>('/orders', signal),
  });
}

export function useClaimOrders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ claimed: number }>('/orders/claim'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ordersKey }),
  });
}

export function useOrderLookup() {
  return useMutation({
    mutationFn: (input: { orderNumber: string; email: string }) =>
      api.post<{ orderNumber: string; token: string }>('/orders/lookup', input),
  });
}

/* ---------------- copy ---------------- */

export const STATUS_COPY: Record<OrderStatus, { label: string; body: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  PENDING_PAYMENT: { label: 'Awaiting payment', body: 'Your items are reserved while you complete payment.', tone: 'warning' },
  PAYMENT_FAILED: { label: 'Payment unsuccessful', body: 'No money was taken. You can try again while your items are reserved.', tone: 'danger' },
  EXPIRED: { label: 'Expired', body: 'Payment wasn’t completed in time, so the reservation ended. Your bag is still saved.', tone: 'neutral' },
  PAID: { label: 'Payment received', body: 'We’re confirming your order.', tone: 'success' },
  PAID_UNFULFILLABLE: { label: 'Couldn’t be fulfilled', body: 'Your payment arrived after the items sold out. A full refund is on its way.', tone: 'danger' },
  CONFIRMED: { label: 'Confirmed', body: 'We’re getting your order ready. We’ll email you when it ships.', tone: 'success' },
  PACKED: { label: 'Packed', body: 'Your order is packed and waiting for the courier.', tone: 'success' },
  SHIPPED: { label: 'Shipped', body: 'Your order is on its way.', tone: 'success' },
  OUT_FOR_DELIVERY: { label: 'Out for delivery', body: 'Arriving today.', tone: 'success' },
  DELIVERED: { label: 'Delivered', body: 'Enjoy your new pair.', tone: 'success' },
  CANCELLED: { label: 'Cancelled', body: 'This order was cancelled.', tone: 'neutral' },
};

export const FAILURE_COPY: Record<string, string> = {
  card_declined: 'Your bank declined the payment.',
  insufficient_funds: 'The payment failed because of insufficient funds.',
  user_cancelled: 'You cancelled the payment.',
  timeout: 'We didn’t hear back from your bank in time.',
  bank_declined_after_pending: 'Your bank declined the payment after reviewing it.',
  order_expired: 'The time to pay for this order ran out.',
  superseded: 'You started a new payment.',
};

export const failureText = (reason: string | null) => (reason && FAILURE_COPY[reason]) || 'The payment didn’t go through.';

const TIMELINE: { label: string; reached: OrderStatus[] }[] = [
  { label: 'Order placed', reached: ['PENDING_PAYMENT'] },
  { label: 'Payment confirmed', reached: ['PAID'] },
  { label: 'Order confirmed', reached: ['CONFIRMED'] },
  { label: 'Packed', reached: ['PACKED'] },
  { label: 'Shipped', reached: ['SHIPPED'] },
  { label: 'Out for delivery', reached: ['OUT_FOR_DELIVERY'] },
  { label: 'Delivered', reached: ['DELIVERED'] },
];

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Fulfilment timeline for orders on the happy path (null for expired/failed/cancelled ones). */
export function timelineFor(order: OrderDto): TimelineStep[] | null {
  if (!['PAID', 'CONFIRMED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(order.status)) return null;
  const at = (s: OrderStatus) => {
    if (s === 'PENDING_PAYMENT') return order.placedAt;
    return [...order.events].reverse().find((e) => e.toStatus === s)?.at;
  };
  const currentIndex = TIMELINE.findIndex((t) => t.reached.includes(order.status));
  return TIMELINE.map((t, i) => {
    const when = at(t.reached[0]!);
    return {
      label: t.label,
      at: i <= currentIndex && when ? dateTime(when) : undefined,
      state: i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming',
    };
  });
}

export const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });

export function useCancelOrder(orderNumber: string, token?: string | null) {
  const qc = useQueryClient();
  const intent = useIntentKey();
  return useMutation({
    mutationFn: (input: { itemIds?: string[]; reason: string }) =>
      api.post<{ order: OrderDto }>(withToken(`/orders/${orderNumber}/cancel`, token), input, { idempotencyKey: intent.get() }),
    onSettled: (_d, err) => intent.settle(err),
    onSuccess: ({ order }) => {
      qc.setQueryData(['orders', orderNumber, token ?? null], { order });
      void qc.invalidateQueries({ queryKey: ordersKey });
    },
  });
}

export const invoiceUrl = (orderNumber: string, token?: string | null) => `/api/v1${withToken(`/orders/${orderNumber}/invoice`, token)}`;

export const REFUND_STATUS_COPY: Record<RefundDto['status'], { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  INITIATED: { label: 'Refund initiated', tone: 'neutral' },
  PROCESSING: { label: 'Processing', tone: 'neutral' },
  FAILED: { label: 'Delayed — retrying', tone: 'warning' },
  FALLBACK_TO_POINTS: { label: 'Refunding as points', tone: 'neutral' },
  COMPLETED: { label: 'Refunded', tone: 'success' },
};

export const RETURN_STATUS_COPY: Record<ReturnStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  REQUESTED: { label: 'Requested', tone: 'neutral' },
  PICKUP_SCHEDULED: { label: 'Pickup scheduled', tone: 'warning' },
  PICKED_UP: { label: 'Picked up', tone: 'warning' },
  RECEIVED: { label: 'Received', tone: 'warning' },
  INSPECTED: { label: 'Inspected', tone: 'warning' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export const REASON_COPY: Record<string, string> = {
  changed_mind: 'Changed my mind',
  ordered_by_mistake: 'Ordered by mistake',
  found_better_price: 'Found a better price',
  delivery_too_slow: 'Delivery is too slow',
  wrong_size: 'Ordered the wrong size',
  too_small: 'Too small',
  too_large: 'Too large',
  not_as_described: 'Not as described',
  damaged: 'Arrived damaged',
  wrong_item: 'Received the wrong item',
  quality: 'Quality not as expected',
  other: 'Other',
};

export const dateTimeText = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
