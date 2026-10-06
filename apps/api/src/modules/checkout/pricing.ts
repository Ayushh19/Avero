import { allocate, formatINR, includedGst, percentOf, type ErrorCode, type ShippingMethod } from '@avero/shared';
import { business } from '../../config/business';

/**
 * Pure pricing for a checkout quote. No I/O: callers load live prices, coupon and balance.
 * All amounts are integer paise. Order of operations (docs/BUSINESS_RULES.md):
 *   items subtotal → coupon discount → shipping → points (≤ 20% of subtotal after coupon, ≤ balance)
 *   total = subtotal − coupon − points + shipping
 * Order-level discounts are allocated to lines with the largest-remainder method so line totals
 * sum exactly to the order total excluding shipping.
 */

export interface PricingLine {
  skuId: string;
  qty: number;
  unitPricePaise: number;
  gstRateBps: number;
  /** Whether the coupon's category/collection restrictions include this line. */
  couponEligible: boolean;
}

export interface PricingCoupon {
  code: string;
  kind: 'percent' | 'flat' | 'free_shipping';
  /** percent: basis points; flat: paise. */
  value: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number;
}

export interface PricingInput {
  lines: PricingLine[];
  shippingMethod: ShippingMethod;
  coupon: PricingCoupon | null;
  pointsRequested: number;
  pointsBalance: number;
  /** Guests can't redeem or earn points. */
  member: boolean;
  /** Override of `business.freeShippingThresholdPaise` (tests). */
  freeShippingThresholdPaise?: number;
}

export interface PricedLine {
  skuId: string;
  subtotalPaise: number;
  discountPaise: number;
  pointsDiscountPaise: number;
  totalPaise: number;
  taxIncludedPaise: number;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotalPaise: number;
  couponApplied: boolean;
  couponError: { code: ErrorCode; message: string } | null;
  couponDiscountPaise: number;
  shippingFeePaise: number;
  shippingWaivedPaise: number;
  shippingPaise: number;
  maxRedeemablePoints: number;
  pointsRedeemed: number;
  pointsDiscountPaise: number;
  totalPaise: number;
  taxIncludedPaise: number;
  pointsToEarn: number;
}

export function shippingFee(method: ShippingMethod, subtotalPaise: number, threshold: number = business.freeShippingThresholdPaise): number {
  if (subtotalPaise === 0) return 0;
  if (method === 'express') return business.shipping.express.feePaise;
  return subtotalPaise >= threshold ? 0 : business.shipping.standard.feePaise;
}

/** Points that a paid amount (excluding shipping) earns: 1 per ₹100. */
export function pointsForPaid(paidExShippingPaise: number): number {
  return Math.max(0, Math.floor(paidExShippingPaise / business.points.paisePerPoint));
}

export function priceQuote(input: PricingInput): PricingResult {
  const subtotals = input.lines.map((l) => l.unitPricePaise * l.qty);
  const subtotal = subtotals.reduce((a, b) => a + b, 0);
  const fee = shippingFee(input.shippingMethod, subtotal, input.freeShippingThresholdPaise);

  // ---- coupon
  let couponDiscount = 0;
  let waived = 0;
  let couponError: PricingResult['couponError'] = null;
  const c = input.coupon;
  if (c) {
    const eligibleSubtotal = input.lines.reduce((s, l, i) => s + (l.couponEligible ? subtotals[i]! : 0), 0);
    if (subtotal < c.minOrderPaise) {
      couponError = { code: 'COUPON_MIN_NOT_MET', message: `${c.code} needs an order of at least ${formatINR(c.minOrderPaise)}` };
    } else if (eligibleSubtotal === 0) {
      couponError = { code: 'COUPON_NOT_APPLICABLE', message: `${c.code} doesn’t apply to the items in your bag` };
    } else if (c.kind === 'free_shipping') {
      if (input.shippingMethod === 'express') {
        couponError = { code: 'COUPON_NOT_APPLICABLE', message: `${c.code} applies to standard delivery only` };
      } else {
        waived = fee;
      }
    } else if (c.kind === 'percent') {
      couponDiscount = percentOf(eligibleSubtotal, c.value);
      if (c.maxDiscountPaise !== null) couponDiscount = Math.min(couponDiscount, c.maxDiscountPaise);
    } else {
      couponDiscount = Math.min(c.value, eligibleSubtotal);
    }
  }
  const lineDiscounts = allocate(
    couponDiscount,
    input.lines.map((l, i) => (l.couponEligible ? subtotals[i]! : 0)),
  );

  // ---- points
  const afterCoupon = subtotal - couponDiscount;
  const capPoints = Math.floor(percentOf(afterCoupon, business.points.maxRedeemBps) / business.points.pointValuePaise);
  const maxRedeemable = input.member ? Math.max(0, Math.min(input.pointsBalance, capPoints)) : 0;
  const pointsRedeemed = Math.min(Math.max(0, input.pointsRequested), maxRedeemable);
  const pointsDiscount = pointsRedeemed * business.points.pointValuePaise;
  const linePoints = allocate(
    pointsDiscount,
    input.lines.map((_, i) => subtotals[i]! - lineDiscounts[i]!),
  );

  const lines: PricedLine[] = input.lines.map((l, i) => {
    const total = subtotals[i]! - lineDiscounts[i]! - linePoints[i]!;
    return {
      skuId: l.skuId,
      subtotalPaise: subtotals[i]!,
      discountPaise: lineDiscounts[i]!,
      pointsDiscountPaise: linePoints[i]!,
      totalPaise: total,
      taxIncludedPaise: includedGst(total, l.gstRateBps),
    };
  });

  const shipping = fee - waived;
  const itemsTotal = afterCoupon - pointsDiscount;
  return {
    lines,
    subtotalPaise: subtotal,
    couponApplied: c !== null && couponError === null,
    couponError,
    couponDiscountPaise: couponDiscount,
    shippingFeePaise: fee,
    shippingWaivedPaise: waived,
    shippingPaise: shipping,
    maxRedeemablePoints: maxRedeemable,
    pointsRedeemed,
    pointsDiscountPaise: pointsDiscount,
    totalPaise: itemsTotal + shipping,
    taxIncludedPaise: lines.reduce((s, l) => s + l.taxIncludedPaise, 0),
    pointsToEarn: input.member ? pointsForPaid(itemsTotal) : 0,
  };
}

