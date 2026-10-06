/**
 * Machine-readable error codes shared by API and web.
 * The web app maps these to user-facing copy; the API pairs each with an HTTP status.
 */
export const ERROR_STATUS = {
  // generic
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  INVALID_STATE_TRANSITION: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,

  // auth
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  TOKEN_INVALID: 400,
  ACCOUNT_LINK_REQUIRED: 409,
  GOOGLE_NOT_CONFIGURED: 503,
  OAUTH_FAILED: 400,

  // catalog / inventory
  SKU_OUT_OF_STOCK: 409,
  SKU_UNAVAILABLE: 409,
  QTY_ADJUSTED: 200,

  // bag / checkout
  CART_VERSION_CONFLICT: 409,
  CART_NOT_READY: 409,
  SHIPPING_METHOD_UNAVAILABLE: 422,
  QUOTE_CHANGED: 409,
  QUOTE_EXPIRED: 409,
  PINCODE_NOT_SERVICEABLE: 422,

  // coupons / points
  COUPON_NOT_FOUND: 404,
  COUPON_EXPIRED: 422,
  COUPON_NOT_STARTED: 422,
  COUPON_LIMIT_REACHED: 422,
  COUPON_MIN_NOT_MET: 422,
  COUPON_NOT_APPLICABLE: 422,
  POINTS_INSUFFICIENT: 422,

  // payments / orders
  PAYMENT_FAILED: 402,
  PAYMENT_IN_PROGRESS: 409,
  ORDER_NOT_PAYABLE: 409,
  WEBHOOK_SIGNATURE_INVALID: 401,
  ORDER_NOT_CANCELLABLE: 409,
  REFUND_EXCEEDS_PAID: 409,

  // returns / reviews
  RETURN_WINDOW_CLOSED: 409,
  RETURN_NOT_ELIGIBLE: 409,
  EXCHANGE_UNAVAILABLE: 409,
  REVIEW_NOT_ELIGIBLE: 403,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.code === 'string'
  );
}
