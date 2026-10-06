# AVERO — Edge Cases

Each case lists the expected behaviour and the error code (from `packages/shared/src/errors.ts`) where relevant. Every case should have an automated test.

| # | Situation | Behaviour | Code |
|---|---|---|---|
| 1 | Product goes out of stock during checkout | Reservation fails at place-order; user returned to bag with the line flagged; options: remove, wishlist, notify me | `SKU_OUT_OF_STOCK` |
| 2 | Specific size/variant unavailable | Same as 1, plus suggestions of nearby in-stock sizes / other colours | `SKU_OUT_OF_STOCK` |
| 3 | Price changed after add-to-bag | Bag shows "Price changed from ₹X to ₹Y"; quote recomputed; stale quote rejected with diff | `QUOTE_CHANGED` |
| 4 | Coupon expired | Removed at quote time with reason; atomic re-check at placement | `COUPON_EXPIRED` |
| 5 | Coupon usage limit reached | Atomic counter check in order transaction | `COUPON_LIMIT_REACHED` |
| 6 | Two users buy the last item | Conditional reserve → exactly one wins; other gets error **before** paying | `SKU_OUT_OF_STOCK` |
| 7 | Duplicate payment requests (double click) | Button disabled + idempotency key → same attempt returned | — |
| 8 | Duplicate webhooks | Unique `event_id`; replay acknowledged, no side effects | — |
| 9 | Payment succeeds but browser closes | Webhook updates order server-side; confirmation email sent; next visit shows confirmed order | — |
| 10 | Payment pending | Order stays `PENDING_PAYMENT`, stock reserved; resolver/reconcile job settles it before TTL; processing page polls | — |
| 11 | Payment failed / cancelled / timeout | Reservation released (or kept for in-window retry); bag intact; one-click retry | `PAYMENT_FAILED` |
| 12 | Network failure during checkout | Client retries with same idempotency key; server returns original result | — |
| 13 | Refresh during checkout / payment | Checkout session + payment attempt are server-side; processing page is idempotent | — |
| 14 | Session expires mid-checkout | Bag preserved (server); after sign-in user returns to checkout with data intact | `UNAUTHENTICATED` |
| 15 | Guest bag + existing account bag | Merge with max-qty rule, clamp to stock; "We merged your bag" notice | — |
| 16 | Bag changed on another device | `version` conflict → 409 with fresh bag; refetch on window focus | `CART_VERSION_CONFLICT` |
| 17 | Product discontinued | Stays viewable; not purchasable; flagged in bag/wishlist; excluded from totals | `SKU_UNAVAILABLE` |
| 18 | Return window expired | Action hidden with "Return window closed on <date>"; server enforces | `RETURN_WINDOW_CLOSED` |
| 19 | Exchange size unavailable | Unavailable options disabled; server re-checks via reservation; return offered | `EXCHANGE_UNAVAILABLE` |
| 20 | Refund failure | Auto-retry with backoff; user sees "Refund delayed"; fallback to points after N failures | — |
| 21 | Invalid / unserviceable address | PIN check on entry and at placement; clear message | `PINCODE_NOT_SERVICEABLE` |
| 22 | Reservation expires while on gateway page | Gateway shows countdown; late success → try re-reserve, else `PAID_UNFULFILLABLE` → auto full refund + apology | — |
| 23 | Partial cancellation of discounted order | Refund = item's allocated share; never exceeds paid | — |
| 24 | Refund exceeding paid amount (bug/race) | Rejected by service check + DB constraint | `REFUND_EXCEEDS_PAID` |
| 25 | Invalid order state transition | Rejected and logged | `INVALID_STATE_TRANSITION` |
| 26 | Review by non-purchaser | Rejected | `REVIEW_NOT_ELIGIBLE` |
| 27 | Idempotency key reused with different body | Rejected | `IDEMPOTENCY_KEY_REUSED` |
| 28 | Quantity above stock / per-order limit | Clamped with message | `QTY_ADJUSTED` (warning) |
| 29 | Google sign-in with email of an existing password account | Linked only if Google email is verified; otherwise asks to sign in with password | `ACCOUNT_LINK_REQUIRED` |
| 30 | Points redeemed but order fails | Redeemed points reversed | — |
| 31 | Coupon applied, then bag drops below minimum | Coupon flagged as not applicable with reason | `COUPON_MIN_NOT_MET` |
| 32 | Guest order email later signs up | Orders claimable after email verification | — |
| 33 | Verification / reset link reused or expired | Clear error with resend option | `TOKEN_INVALID` |
