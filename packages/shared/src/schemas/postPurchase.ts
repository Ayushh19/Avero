import { z } from 'zod';
import type { RefundStatus, ReturnStatus } from '../states';

/* ---------------- notifications ---------------- */

export const NOTIFICATION_KINDS = [
  'order',
  'payment',
  'refund',
  'return',
  'stock_alert',
  'price_drop',
  'review_prompt',
  'points',
  'referral',
  'account',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Service messages about the shopper's own orders and money: always emailed (in-app can be muted). */
export const TRANSACTIONAL_NOTIFICATION_KINDS: readonly NotificationKind[] = ['order', 'payment', 'refund', 'return', 'account'];

export interface NotificationDto {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationListDto {
  notifications: NotificationDto[];
  unreadCount: number;
  nextCursor: string | null;
}

export const markNotificationsReadSchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
  z.object({ all: z.literal(true) }),
]);

export interface NotificationPreferenceDto {
  kind: NotificationKind;
  inApp: boolean;
  email: boolean;
  /** Email can't be turned off for transactional kinds. */
  emailLocked: boolean;
}

export const notificationPreferencesSchema = z.object({
  preferences: z
    .array(z.object({ kind: z.enum(NOTIFICATION_KINDS), inApp: z.boolean(), email: z.boolean() }))
    .min(1)
    .max(NOTIFICATION_KINDS.length),
});

/* ---------------- cancellation ---------------- */

export const CANCEL_REASONS = [
  'changed_mind',
  'ordered_by_mistake',
  'found_better_price',
  'delivery_too_slow',
  'wrong_size',
  'other',
] as const;

export const cancelOrderSchema = z.object({
  /** Omit to cancel every active item (the whole order). Whole lines only. */
  itemIds: z.array(z.uuid()).min(1).max(50).optional(),
  reason: z.enum(CANCEL_REASONS),
});

/* ---------------- returns & exchanges ---------------- */

export const RETURN_REASONS = [
  'too_small',
  'too_large',
  'not_as_described',
  'damaged',
  'wrong_item',
  'quality',
  'changed_mind',
  'other',
] as const;

export const createReturnSchema = z
  .object({
    orderNumber: z.string().trim().min(1).max(32),
    kind: z.enum(['return', 'exchange']),
    items: z
      .array(
        z.object({
          orderItemId: z.uuid(),
          reason: z.enum(RETURN_REASONS),
          comment: z.string().trim().max(500).optional(),
          /** Exchange only: the size/colour wanted instead (same product, same price). */
          exchangeSkuId: z.uuid().optional(),
        }),
      )
      .min(1)
      .max(20),
    refundDestination: z.enum(['original', 'points']).default('original'),
  })
  .refine((v) => v.kind === 'return' || v.items.every((i) => i.exchangeSkuId), {
    message: 'Choose the size or colour you want for each exchanged item',
    path: ['items'],
  });
export type CreateReturnInput = z.infer<typeof createReturnSchema>;

export interface ExchangeOptionDto {
  skuId: string;
  colorwayId: string;
  colorName: string;
  sizeLabel: string;
  available: boolean;
}

export interface ReturnOptionItemDto {
  orderItemId: string;
  productName: string;
  colorName: string;
  sizeLabel: string;
  imageUrl: string | null;
  qty: number;
  totalPaise: number;
  returnable: boolean;
  /** Why not, when `returnable` is false. */
  reason: string | null;
  exchangeOptions: ExchangeOptionDto[];
}

export interface ReturnOptionsDto {
  orderNumber: string;
  windowEndsAt: string | null;
  windowOpen: boolean;
  /** Guests can only be refunded to the original payment method. */
  pointsRefundAllowed: boolean;
  items: ReturnOptionItemDto[];
}

export interface RefundDto {
  id: string;
  amountPaise: number;
  pointsAmount: number;
  destination: 'original' | 'points';
  status: RefundStatus;
  reason: string;
  attempts: number;
  createdAt: string;
  completedAt: string | null;
}

export interface ReturnItemDto {
  orderItemId: string;
  productName: string;
  colorName: string;
  sizeLabel: string;
  imageUrl: string | null;
  qty: number;
  totalPaise: number;
  reason: string;
  comment: string | null;
  exchangeFor: { colorName: string; sizeLabel: string } | null;
}

export interface ReturnDto {
  rmaNumber: string;
  orderNumber: string;
  kind: 'return' | 'exchange';
  status: ReturnStatus;
  refundDestination: 'original' | 'points';
  createdAt: string;
  items: ReturnItemDto[];
  /** Expected refund (returns): items' paid totals; shipping is not refunded. */
  refundPaise: number;
  refund: RefundDto | null;
  replacementOrderNumber: string | null;
  canCancel: boolean;
  timeline: { status: ReturnStatus; at: string }[];
}

export interface ReturnSummaryDto {
  rmaNumber: string;
  orderNumber: string;
  kind: 'return' | 'exchange';
  status: ReturnStatus;
  createdAt: string;
  itemCount: number;
}

/* ---------------- tracking ---------------- */

export interface TrackingEventDto {
  status: string;
  description: string;
  location: string | null;
  at: string;
}

export interface ShipmentDto {
  kind: 'forward' | 'return_pickup' | 'exchange';
  carrier: string;
  trackingNumber: string;
  status: string;
  events: TrackingEventDto[];
}
