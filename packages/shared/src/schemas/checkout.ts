import { z } from 'zod';
import type { OrderItemStatus, OrderStatus, PaymentStatus } from '../states';
import type { ErrorCode } from '../errors';
import { emailSchema, indianPhoneSchema } from './auth';
import type { ImageDto } from './catalog';
import type { RefundDto, ReturnSummaryDto, ShipmentDto } from './postPurchase';
import { addressSchema } from './shopping';

/* ---------------- checkout session ---------------- */

export const SHIPPING_METHODS = ['standard', 'express'] as const;
export type ShippingMethod = (typeof SHIPPING_METHODS)[number];

export const checkoutAddressSchema = addressSchema.omit({ isDefault: true });
export type CheckoutAddressInput = z.infer<typeof checkoutAddressSchema>;

/**
 * Starts (or resumes) checkout. Without `buyNow` the session checks out the bag; with it, the
 * session buys only that SKU and leaves the bag alone.
 */
export const startCheckoutSchema = z.object({
  buyNow: z.object({ skuId: z.uuid(), qty: z.number().int().min(1).max(10).default(1) }).optional(),
});
export type StartCheckoutInput = z.infer<typeof startCheckoutSchema>;

/**
 * Partial update of a checkout session. Every field is optional; `null` clears coupon.
 * Any change invalidates the current quote.
 */
export const checkoutSessionPatchSchema = z
  .object({
    email: emailSchema.optional(),
    phone: indianPhoneSchema.optional(),
    /** A saved address (members only). */
    addressId: z.uuid().optional(),
    /** A new address. Members may also save it to their address book. */
    address: checkoutAddressSchema.optional(),
    saveAddress: z.boolean().optional(),
    shippingMethod: z.enum(SHIPPING_METHODS).optional(),
    couponCode: z.string().trim().min(1).max(40).nullable().optional(),
    pointsToRedeem: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((v) => !(v.addressId && v.address), 'Send either addressId or address, not both');
export type CheckoutSessionPatch = z.infer<typeof checkoutSessionPatchSchema>;

export const placeOrderSchema = z.object({
  sessionId: z.uuid(),
  quoteHash: z.string().min(16).max(128),
});

export interface QuoteLineDto {
  skuId: string;
  skuCode: string;
  productName: string;
  productSlug: string;
  colorName: string;
  sizeLabel: string;
  href: string;
  image: ImageDto | null;
  qty: number;
  unitPricePaise: number;
  mrpPaise: number;
  /** unit price × qty */
  subtotalPaise: number;
  /** Allocated share of the coupon discount. */
  discountPaise: number;
  /** Allocated share of the points discount. */
  pointsDiscountPaise: number;
  totalPaise: number;
  gstRateBps: number;
  taxIncludedPaise: number;
}

export interface QuoteDto {
  lines: QuoteLineDto[];
  itemCount: number;
  subtotalPaise: number;
  /** MRP savings, informational. */
  savingsPaise: number;
  coupon: { code: string; description: string; kind: 'percent' | 'flat' | 'free_shipping' } | null;
  /** Set when the session has a coupon that no longer applies; the quote is priced without it. */
  couponError: { code: ErrorCode; message: string } | null;
  couponDiscountPaise: number;
  shipping: {
    method: ShippingMethod;
    feePaise: number;
    /** Part of the fee waived by a free-shipping coupon. */
    waivedPaise: number;
    earliest: string;
    latest: string;
  };
  shippingPaise: number;
  points: { balance: number; maxRedeemable: number; redeemed: number };
  pointsDiscountPaise: number;
  totalPaise: number;
  taxIncludedPaise: number;
  /** Estimate: pending points credited when the payment succeeds (members only). */
  pointsToEarn: number;
  hash: string;
  expiresAt: string;
}

export interface CheckoutSessionDto {
  id: string;
  status: 'open' | 'order_placed' | 'abandoned';
  /** `bag`: everything in the bag; `buy_now`: the single item chosen with "Buy now". */
  mode: 'bag' | 'buy_now';
  /** What this checkout will buy (live prices; the quote is authoritative once it exists). */
  items: { skuId: string; productName: string; colorName: string; sizeLabel: string; image: ImageDto | null; qty: number; totalPaise: number }[];
  subtotalPaise: number;
  isGuest: boolean;
  email: string | null;
  phone: string | null;
  address: CheckoutAddressInput | null;
  shippingMethod: ShippingMethod;
  /** Shipping options available for the chosen PIN code. */
  shippingOptions: { method: ShippingMethod; label: string; feePaise: number; earliest: string; latest: string }[];
  couponCode: string | null;
  pointsToRedeem: number;
  /** The last confirmed quote, if still current. */
  quote: QuoteDto | null;
  /** True when contact + address are complete and a quote can be requested. */
  ready: boolean;
  /** Coupons issued to this shopper only (e.g. referral welcome offer), not yet used. */
  personalCoupons: { code: string; description: string }[];
  /** An earlier order from this checkout source (bag, or the same buy-now item) still waiting for payment (offer "resume payment"). */
  pendingOrder: { orderNumber: string; totalPaise: number; reservationExpiresAt: string } | null;
}

/* ---------------- orders ---------------- */

export interface OrderItemDto {
  id: string;
  skuId: string;
  productName: string;
  productSlug: string;
  colorName: string;
  sizeLabel: string;
  href: string;
  imageUrl: string | null;
  qty: number;
  unitPricePaise: number;
  mrpPaise: number;
  discountPaise: number;
  pointsDiscountPaise: number;
  totalPaise: number;
  status: OrderItemStatus;
  /** Can be cancelled now (active, order not yet shipped). */
  cancellable: boolean;
}

export interface OrderEventDto {
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  at: string;
}

export interface OrderDto {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  placedAt: string;
  email: string;
  phone: string;
  isGuest: boolean;
  address: CheckoutAddressInput;
  shippingMethod: ShippingMethod;
  items: OrderItemDto[];
  subtotalPaise: number;
  discountPaise: number;
  couponCode: string | null;
  shippingPaise: number;
  pointsRedeemed: number;
  pointsDiscountPaise: number;
  totalPaise: number;
  taxIncludedPaise: number;
  paidPaise: number;
  refundedPaise: number;
  /** Pending points recorded for this order (members). */
  pointsEarned: number;
  reservationExpiresAt: string | null;
  expectedDeliveryAt: string | null;
  /** Payment can be (re)tried now: awaiting payment or failed, reservation alive, no attempt in flight. */
  canPay: boolean;
  latestPayment: PaymentAttemptDto | null;
  events: OrderEventDto[];
  /** `exchange`: zero-value replacement created by an exchange of `parentOrderNumber`. */
  kind: 'sale' | 'exchange';
  parentOrderNumber: string | null;
  deliveredAt: string | null;
  returnWindowEndsAt: string | null;
  cancelledAt: string | null;
  /** Some items can still be cancelled. */
  canCancel: boolean;
  /** At least one item can be returned or exchanged now. */
  canReturn: boolean;
  invoiceAvailable: boolean;
  shipments: ShipmentDto[];
  refunds: RefundDto[];
  returns: ReturnSummaryDto[];
}

export interface OrderSummaryDto {
  orderNumber: string;
  status: OrderStatus;
  placedAt: string;
  totalPaise: number;
  itemCount: number;
  images: string[];
}

export interface OrderListDto {
  orders: OrderSummaryDto[];
  /** Guest orders placed with this (verified) email that can be added to the account. */
  claimable: number;
}

export const orderLookupSchema = z.object({
  orderNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^AV-\d{4}-[0-9A-Z]{5}$/, 'Enter the order number from your confirmation email, e.g. AV-2610-7K3QD'),
  email: emailSchema,
});

/* ---------------- payments ---------------- */

export const PAYMENT_METHODS = ['upi', 'card', 'netbanking'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Outcomes the simulated gateway can be told to produce. See docs/PAYMENTS.md. */
export const PAYMENT_SCENARIOS = [
  'success',
  'failure_declined',
  'failure_insufficient',
  'pending',
  'cancelled',
  'timeout',
  'success_no_redirect',
  'duplicate_webhook',
  'late_success',
] as const;
export type PaymentScenario = (typeof PAYMENT_SCENARIOS)[number];

export const createPaymentAttemptSchema = z.object({
  orderNumber: z.string().trim().min(1).max(32),
  method: z.enum(PAYMENT_METHODS),
});

export const gatewaySubmitSchema = z.object({
  scenario: z.enum(PAYMENT_SCENARIOS),
  /** For `pending`: how the payment eventually resolves. */
  pendingResolution: z.enum(['success', 'failure']).default('success'),
});

export interface PaymentAttemptDto {
  id: string;
  orderNumber: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amountPaise: number;
  failureReason: string | null;
  gatewayRef: string;
  expiresAt: string;
  settledAt: string | null;
}

export interface PaymentAttemptStatusDto {
  attempt: PaymentAttemptDto;
  order: { orderNumber: string; status: OrderStatus; reservationExpiresAt: string | null; canPay: boolean };
}

export interface GatewayChargeDto {
  gatewayRef: string;
  merchant: string;
  amountPaise: number;
  method: PaymentMethod;
  status: 'created' | 'processing' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  expiresAt: string;
  scenarios: readonly PaymentScenario[];
}

export interface GatewaySubmitResponse {
  /** Where the browser goes next; `null` simulates a closed tab (success_no_redirect). */
  redirectUrl: string | null;
}
