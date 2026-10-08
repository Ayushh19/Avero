# AVERO — Business Rules

The backend enforces every rule below. The frontend may pre-check for UX, but is never trusted.

## Configuration (initial values, in `apps/api/src/config/business.ts`)
| Setting | Value |
|---|---|
| Currency | INR, integer paise |
| Prices | GST-inclusive; GST rate per product (`gst_rate_bps`), shown as breakdown on invoice |
| Free shipping threshold | ₹0 — standard delivery is free on every order (changed from ₹2,999 on 2026-10-06: every product is above ₹2,999, so the threshold only produced a meaningless message). `business.freeShippingThresholdPaise`; all shopper-facing copy follows it |
| Standard shipping fee | ₹99 (3–6 days) — only charged if a threshold is set again |
| Express shipping fee | ₹199 (1–2 days, select PIN ranges only) |
| Inventory reservation TTL | 15 minutes |
| Checkout quote TTL | 10 minutes |
| Max qty per SKU per order | 5 (overridable per SKU) |
| Low-stock threshold | 5 (per SKU) |
| Return / exchange window | 15 days after delivery |
| Points earn rate | 1 point per ₹100 paid (excl. shipping) |
| Points value | 1 point = ₹1 |
| Max points redemption | 20% of order subtotal after discounts |
| Points pending until | return window closes |
| Points expiry | 12 months after becoming available |
| Review bonus | 25 points (once per review, after review published) |
| Referral | referee: ₹250 off first order ≥ ₹1,999; referrer: 250 points after referee's first order clears return window |
| Refund retry | 3 attempts with backoff, then fallback to points |

## Pricing & money
1. The client sends only `skuId` + `qty` (and coupon code / points requested). The server computes every amount.
2. Money is integer paise. Discounts are allocated to lines proportionally (largest-remainder) so line totals sum exactly to the order total.
3. The final **quote** (id + hash + expiry) is what the user confirms. Placing an order with a stale or mismatched quote returns `QUOTE_CHANGED` with a diff; nothing is charged.
4. Orders snapshot all prices, names, sizes, images and address. Later catalog changes never alter orders.

## Inventory
5. `available = on_hand − reserved` can never be negative — enforced by conditional `UPDATE` **and** `CHECK` constraints.
6. Stock is reserved at order placement (start of payment), not at add-to-bag. Reservations expire after the TTL; payment success commits them (`on_hand −= n, reserved −= n`); failure/expiry/cancellation releases them.
7. Every stock change writes an `inventory_movements` row.
8. Only `active` product + colorway + SKU can be added to a bag or purchased. Adding more than available or more than `max_per_order` is clamped with a message.
9. Cancelled/returned items restock (returns restock after inspection).

## Bag
10. One active bag per user; one per guest token. Bag mutations bump `version`.
11. Merge on sign-in: union of lines; same SKU → `max(guestQty, userQty)` clamped to stock and limit; saved-for-later preserved; guest bag marked `merged`. User is notified of the merge.
11a. **After payment succeeds, the purchased quantities are subtracted from the bag** the order came from (decided at Phase 3 kickoff; replaces "bag → `converted`, new empty bag"). Uses the order's line snapshot, not the bag's state at payment time: each ordered SKU reduces its in-bag line (never saved-for-later) by the ordered qty; lines reaching zero are deleted; `version` bumps. Only on success — a failed or expired payment never touches the bag. Why: keeps saved-for-later and anything added after placing the order, and works for guests (the webhook has no response to set a new bag cookie). `carts.status = 'converted'` stays unused.
11b. **Buy now checks out only the chosen item.** It never adds to the bag; the checkout session stores the SKU + qty (`buy_now_sku_id`, `buy_now_qty`) and prices only that. Paying for it never trims the bag (11a doesn't apply), and its unpaid order isn't offered as "resume payment" on the bag's checkout. The session is still anchored to the shopper's bag for ownership.

## Coupons
12. Validated at quote time and atomically at order creation: active, within window, min order met, eligible items present, global `used_count < usage_limit`, per-user/email usage below limit, first-order-only respected.
13. One coupon per order. Redemption row (unique per order) + `used_count` increment happen in the order-creation transaction. Kept through failed payment attempts (so a retry works) and released when the order expires or is fully cancelled before shipping. Not restored on returns.
13a. Late payment success on an expired order re-claims the redemption. If the coupon filled up meanwhile, the price the customer paid is honoured (no extra charge, no cancellation) and `coupon_honoured_over_limit` is recorded in `order_events`. Redeemed points follow the same rule (`points_honoured_without_balance`).

## Orders & payments
14. `POST /checkout/place-order` and `POST /payments/attempts` require `Idempotency-Key`. Retries return the original result; no duplicate orders or attempts.
15. One checkout session → at most one order (unique `checkout_session_id`). One order → at most one succeeded payment.
16. Webhook events are verified (HMAC) and deduped by `event_id`. Processing is transactional; terminal payment states never regress.
17. Order/item/payment/return/refund transitions follow [STATE_MACHINES.md](./STATE_MACHINES.md) only.
18. Cancellation allowed only before `SHIPPED` (whole order or individual items). **Whole lines only** (decided at Phase 4 kickoff). Cancelled stock is back on sale immediately. Exchange replacement orders can't be cancelled.
18a. Guests can cancel and return from the device that placed the order or a signed order link; their refunds always go to the original payment method (points need an account).
19. Unserviceable PIN codes cannot be used for an order; re-checked at placement.

## Refunds
20. `refunded_paise + new_refund ≤ paid_paise` under row lock + `CHECK` constraint.
21. Item refund = item total (after its allocated discount). Points used are returned as points proportionally. Shipping is refunded only on full cancellation before shipping.
22. Refunds are idempotent per (order, source request).
22a. Refund to points (chosen at return, or the fallback after 3 failed bank refunds) credits ⌈amount ÷ ₹1⌉ points, available immediately. Guests have no fallback: after 3 failures their refund retries every 6 hours.
22b. Redeemed points come back with cancelled/returned lines in proportion to each line's points share; the refund that leaves nothing kept returns the remainder, so the total returned equals the total redeemed.

## Returns & exchanges
23. Eligible only if item is `DELIVERED`, within the window, not final-sale, and not already returned/exchanged.
24. Exchange: same product, same price, different size and/or colour; target SKU reserved at request; one exchange per item. If unavailable → `EXCHANGE_UNAVAILABLE`, user offered return.
25. No admin: approval is automatic when eligibility rules pass — a valid request goes straight to `PICKUP_SCHEDULED` (pickup next day). Returned stock goes back on sale at inspection (always passes in simulation).
25a. "Same price" for exchanges means the target SKU's *current* price equals the unit price paid. Items received in an exchange can't be returned or exchanged again (simulation scope).
25b. Whole lines only for returns too.

## Loyalty & referral
26. Points earned = 1 per ₹100 of the amount actually paid excluding shipping (so redeemed points earn nothing). One `earn` row per order, status `pending`, written when the payment succeeds (not at placement). Pending → available after the return window is Phase 5. Cancellations and returns shrink the pending row to the points the kept lines earn (voided when nothing is kept).
27. Redemption ≤ available balance and ≤ 20% of the subtotal after coupon; the `redeem` row is written in the place-order transaction and reversed (row → `void`) when the order expires without payment. Like the coupon, it is kept through failed attempts while the reservation is alive.
28. Referral: no self-referral; referee must be a new email + phone; reward only after the qualifying order clears its return window; one reward per referee.
28a. Points become available when the order's return window closes (job at window close; waits while a return on the order is still in progress, then counts only kept lines). Available earned, bonus and referral points expire 12 months later. Redemptions consume the soonest-expiring points first, so spent points never expire; a warning is sent 30 days before. **Refund credits (returns refunded as points, failed-refund fallback) never expire** (Phase 5 kickoff decision).
28b. Referral: signing up with a code issues the friend a **personal coupon** (₹250 off a first order ≥ ₹1,999, theirs only, valid 90 days), offered at checkout. The friend's first paid order qualifies; if it's fully cancelled or fully returned, a later order can qualify. Codes are ignored (sign-up still succeeds) for self-referral or a phone number already on another account.
28c. Price-drop alerts: members are alerted automatically when a wishlist item reaches a new low below the price when added; anyone can ask on a product page ("Tell me if the price drops", once, below the price they saw). Both respect the price-drop notification preference.

## Reviews
29. Only users with a `DELIVERED` (not returned) order item of the product may review; one review per product per user; editable by the author.
30. Rating aggregates updated transactionally on create/edit/delete.
30a. A verified review earns 25 available points once per product (not clawed back if the review is deleted). Items being returned or returned can't be reviewed. A review reminder is sent 3 days after delivery if a delivered line isn't reviewed yet.

## Access control
31. Users access only their own bag, orders, addresses, returns, notifications.
32. Guest orders are accessible via a signed, expiring token link or order number + email lookup (rate limited).
33. Signing up / verifying an email lets the user claim past guest orders placed with that email.
34. Auth endpoints rate limited; sessions revoked on password change; Google accounts link to an existing account only when Google reports the email as verified.
