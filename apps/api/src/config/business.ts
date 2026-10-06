/** Business configuration. See docs/BUSINESS_RULES.md. All money in paise. */
export const business = {
  currency: 'INR',
  /**
   * Standard delivery is free at or above this subtotal. 0 = free on every order (current policy:
   * the whole catalogue is above ₹2,999, so a threshold only produced a meaningless message).
   * Express delivery is always charged.
   */
  freeShippingThresholdPaise: 0,
  shipping: {
    standard: { feePaise: 99_00, minDays: 3, maxDays: 6 },
    express: { feePaise: 199_00, minDays: 1, maxDays: 2 },
  },
  reservationTtlMinutes: 15,
  quoteTtlMinutes: 10,
  payments: {
    /** A payment attempt lives at most this long (and never past the order's reservation). */
    attemptTtlMinutes: 10,
    /** Reconciliation looks at an unsettled attempt this long after it expires. */
    reconcileGraceSeconds: 60,
    /** Simulated gateway: delay before webhooks, and before a `pending` payment resolves. */
    webhookDelaySeconds: 1,
    pendingResolveSeconds: 30,
    /** `late_success` resolves this long after the order's reservation expired. */
    lateSuccessAfterExpirySeconds: 60,
    webhookToleranceSeconds: 300,
  },
  /** Signed guest order links (emails, /track lookup). */
  guestOrderLinkTtlDays: 30,
  defaultMaxPerOrder: 5,
  defaultLowStockThreshold: 5,
  returnWindowDays: 15,
  points: {
    paisePerPoint: 100_00, // 1 point per ₹100 paid
    pointValuePaise: 1_00, // 1 point = ₹1
    maxRedeemBps: 2000, // 20% of subtotal after discounts
    expiryMonths: 12,
    reviewBonus: 25,
  },
  referral: {
    refereeDiscountPaise: 250_00,
    refereeMinOrderPaise: 1_999_00,
    referrerRewardPoints: 250,
  },
  refundMaxAttempts: 3,
  auth: {
    sessionTtlDays: 30,
    sessionTouchIntervalMinutes: 60,
    verifyEmailTtlHours: 48,
    resetPasswordTtlMinutes: 30,
  },
  idempotencyTtlHours: 24,
  /** India GST on footwear: 5% up to ₹2,500 per unit, 18% above. */
  gst: { thresholdPaise: 2_500_00, lowRateBps: 500, highRateBps: 1800 },
  /** Catalog import: USD source prices → INR. */
  usdToInr: 83,
  /** PDP shows an exact "Only N left" count at or below this. */
  lowStockDisplay: 5,
} as const;
