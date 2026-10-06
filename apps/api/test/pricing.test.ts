import { describe, expect, it } from 'vitest';
import { priceQuote, type PricingInput, type PricingLine } from '../src/modules/checkout/pricing';

const line = (unit: number, qty = 1, extra: Partial<PricingLine> = {}): PricingLine => ({
  skuId: `sku-${unit}-${qty}`,
  qty,
  unitPricePaise: unit,
  gstRateBps: 1800,
  couponEligible: true,
  ...extra,
});

const input = (over: Partial<PricingInput>): PricingInput => ({
  lines: [line(4_999_00)],
  shippingMethod: 'standard',
  coupon: null,
  pointsRequested: 0,
  pointsBalance: 0,
  member: true,
  ...over,
});

const sumLines = (r: ReturnType<typeof priceQuote>) => r.lines.reduce((s, l) => s + l.totalPaise, 0);

describe('pricing', () => {
  it('current policy: standard delivery free on every order; express always ₹199', () => {
    expect(priceQuote(input({ lines: [line(500_00)] })).shippingPaise).toBe(0);
    expect(priceQuote(input({ lines: [line(500_00)], shippingMethod: 'express' })).shippingPaise).toBe(199_00);
  });

  it('with a free-shipping threshold, standard costs ₹99 below it and nothing at or above it', () => {
    const t = { freeShippingThresholdPaise: 2_999_00 };
    expect(priceQuote(input({ lines: [line(1_999_00)], ...t })).shippingPaise).toBe(99_00);
    expect(priceQuote(input({ lines: [line(2_999_00)], ...t })).shippingPaise).toBe(0);
    expect(priceQuote(input({ lines: [line(5_000_00)], shippingMethod: 'express', ...t })).shippingPaise).toBe(199_00);
  });

  it('applies a capped percent coupon and allocates it so lines sum exactly', () => {
    const r = priceQuote(
      input({
        lines: [line(3_333_33), line(1_111_11, 2), line(999_99, 3)],
        coupon: { code: 'P10', kind: 'percent', value: 1000, maxDiscountPaise: 500_00, minOrderPaise: 0 },
      }),
    );
    expect(r.couponDiscountPaise).toBe(500_00); // 10% of ₹8,555 = ₹855, capped at ₹500
    expect(r.lines.reduce((s, l) => s + l.discountPaise, 0)).toBe(500_00);
    expect(sumLines(r) + r.shippingPaise).toBe(r.totalPaise);
    expect(r.totalPaise).toBe(r.subtotalPaise - 500_00);
  });

  it('only discounts eligible lines, and rejects coupons with no eligible lines', () => {
    const coupon = { code: 'RUN', kind: 'flat' as const, value: 300_00, maxDiscountPaise: null, minOrderPaise: 0 };
    const r = priceQuote(input({ lines: [line(2_000_00), line(1_500_00, 1, { couponEligible: false })], coupon }));
    expect(r.lines[0]!.discountPaise).toBe(300_00);
    expect(r.lines[1]!.discountPaise).toBe(0);
    const none = priceQuote(input({ lines: [line(2_000_00, 1, { couponEligible: false })], coupon }));
    expect(none.couponApplied).toBe(false);
    expect(none.couponError?.code).toBe('COUPON_NOT_APPLICABLE');
    expect(none.couponDiscountPaise).toBe(0);
  });

  it('flags a coupon whose minimum is no longer met and prices without it', () => {
    const r = priceQuote(
      input({ lines: [line(1_000_00)], coupon: { code: 'FLAT500', kind: 'flat', value: 500_00, maxDiscountPaise: null, minOrderPaise: 4_999_00 } }),
    );
    expect(r.couponError?.code).toBe('COUPON_MIN_NOT_MET');
    expect(r.totalPaise).toBe(1_000_00);
  });

  it('free-shipping coupon waives standard delivery only', () => {
    const coupon = { code: 'FREESHIP', kind: 'free_shipping' as const, value: 0, maxDiscountPaise: null, minOrderPaise: 0 };
    const std = priceQuote(input({ lines: [line(1_000_00)], coupon, freeShippingThresholdPaise: 2_999_00 }));
    expect(std.shippingWaivedPaise).toBe(99_00);
    expect(std.shippingPaise).toBe(0);
    const exp = priceQuote(input({ lines: [line(1_000_00)], coupon, shippingMethod: 'express' }));
    expect(exp.couponError?.code).toBe('COUPON_NOT_APPLICABLE');
    expect(exp.shippingPaise).toBe(199_00);
  });

  it('caps points at 20% of the subtotal after coupon and at the balance', () => {
    const coupon = { code: 'F1000', kind: 'flat' as const, value: 1_000_00, maxDiscountPaise: null, minOrderPaise: 0 };
    const r = priceQuote(input({ lines: [line(6_000_00)], coupon, pointsRequested: 5_000, pointsBalance: 5_000 }));
    expect(r.maxRedeemablePoints).toBe(1_000); // 20% of ₹5,000
    expect(r.pointsRedeemed).toBe(1_000);
    expect(r.pointsDiscountPaise).toBe(1_000_00);
    expect(r.totalPaise).toBe(4_000_00);
    expect(sumLines(r)).toBe(4_000_00);

    const poor = priceQuote(input({ lines: [line(6_000_00)], pointsRequested: 500, pointsBalance: 120 }));
    expect(poor.pointsRedeemed).toBe(120);
  });

  it('earns 1 point per ₹100 of the amount paid excluding shipping (redeemed points earn nothing)', () => {
    expect(priceQuote(input({ lines: [line(1_999_00)] })).pointsToEarn).toBe(19);
    const r = priceQuote(input({ lines: [line(5_000_00)], pointsRequested: 1_000, pointsBalance: 1_000 }));
    expect(r.pointsToEarn).toBe(40);
    expect(priceQuote(input({ member: false, pointsRequested: 100, pointsBalance: 100 })).pointsRedeemed).toBe(0);
  });

  it('computes included GST per line on the discounted amount', () => {
    const r = priceQuote(input({ lines: [line(1_180_00, 1, { gstRateBps: 1800 }), line(1_050_00, 1, { gstRateBps: 500 })] }));
    expect(r.lines[0]!.taxIncludedPaise).toBe(180_00);
    expect(r.lines[1]!.taxIncludedPaise).toBe(50_00);
    expect(r.taxIncludedPaise).toBe(230_00);
  });
});
