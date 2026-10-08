# AVERO — API Surface (v1)

Base: `/api/v1`. Auth via session cookie; guests identified via `avero_cart` cookie. `🔑` = signed-in required, `♻︎` = requires `Idempotency-Key`. Error envelope and conventions in [ARCHITECTURE.md](./ARCHITECTURE.md).

## System
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + DB check |
| GET | `/config` | Public config (shipping thresholds, return window, Google enabled, etc.) |

## Auth
| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/signup` | Create account (name, email, phone?, password) → session + verification email |
| POST | `/auth/signin` | Email + password |
| POST | `/auth/signout` | Revoke current session |
| GET | `/auth/me` | Current user or `null` |
| POST | `/auth/verify-email` | Consume token |
| POST | `/auth/resend-verification` 🔑 | |
| POST | `/auth/forgot-password` | Always 200 (no account enumeration) |
| POST | `/auth/reset-password` | Consume token, revoke all sessions |
| GET | `/auth/google/start` | Redirect to Google |
| GET | `/auth/google/callback` | OAuth callback → session → redirect to web |
| GET | `/auth/sessions` 🔑 | List devices |
| DELETE | `/auth/sessions/:id` 🔑 | Revoke one; `DELETE /auth/sessions` revokes others |

Sign-in/sign-up also triggers bag merge; the response includes a `merge` summary. Wishlist/recently-viewed merge via their bulk endpoints.

## Catalog & search
| Method | Path | Purpose |
|---|---|---|
| GET | `/categories` | Tree |
| GET | `/collections`, `/collections/:slug` | |
| GET | `/products` | PLP: `category`, `collection`, `q`, `size[]`, `color[]`, `gender[]`, `activity[]`, `price_min`, `price_max`, `rating_min`, `on_sale`, `new`, `sort`, `cursor` → items + facets |
| GET | `/home` | Home composition (hero, tiles, editorial slides, showcase) |
| GET | `/products/by-colorway?ids=` | Cards for a guest's device wishlist / recently viewed |
| GET | `/products/:slug` | PDP aggregate (product, colorways, images, SKUs with availability, size chart, rating summary) |
| GET | `/skus/availability?ids=` | Fresh stock states (short cache) |
| GET | `/search/suggest?q=` | Grouped suggestions |
| GET | `/search/trending` | |
| GET | `/products/:slug/recommendations` | You may also like |
| GET | `/products/:slug/frequently-bought-together` | Up to 3: co-purchases in paid orders, topped up with popular in-stock products |
| GET | `/products/:slug/reviews` | `?sort=recent\|helpful\|rating_high\|rating_low&rating=&page=` → summary (average, count, distribution, fit), 10 per page, `canReview`, `myReviewId` |
| GET | `/home/personal` | Rows "Picked for you" (member history, or `?viewed=` colourway ids for guests) and "Wishlist price drops" |
| GET | `/delivery/estimate?pincode=&skuId=` | Serviceability + ETA |

## Bag
| Method | Path | Purpose |
|---|---|---|
| GET | `/cart` | Bag with per-line validation issues + server totals |
| POST | `/cart/items` | Add `{ skuId, qty }` |
| PATCH | `/cart/items/:id` | Change qty / save for later `{ qty?, savedForLater?, expectedVersion }` (409 `CART_VERSION_CONFLICT` includes the fresh bag) |
| DELETE | `/cart/items/:id` | Remove |
| POST | `/cart/acknowledge-prices` | Mark price changes as seen |

## Wishlist, recently viewed, alerts
| Method | Path | Purpose |
|---|---|---|
| GET/POST/DELETE | `/wishlist`, `/wishlist/:colorwayId` 🔑 | |
| POST | `/wishlist/merge` 🔑 | Bulk merge local items |
| GET/POST | `/recently-viewed` 🔑, `/recently-viewed/merge` 🔑 | |
| POST | `/alerts/stock` | Notify me (user or email) |

## Account
| Method | Path | Purpose |
|---|---|---|
| GET/PATCH | `/account/profile` 🔑 | |
| POST | `/account/password` 🔑 | Change / set password |
| GET/POST/PUT/DELETE | `/account/addresses[/:id]` 🔑 | `POST /account/addresses/:id/default` sets default |
| GET | `/pincodes/:pincode` | Serviceability + city/state autofill |

## Checkout & payments
| Method | Path | Purpose |
|---|---|---|
| POST | `/checkout/session` | `{ buyNow?: { skuId, qty } }`. Create or resume the open session for the bag — or, with `buyNow`, for that one item alone (`mode: 'buy_now'`; `SKU_OUT_OF_STOCK`/`SKU_UNAVAILABLE` if it can't be bought). Members prefilled; `pendingOrder` if an earlier order from this bag awaits payment. `CART_NOT_READY` for empty/blocked bags |
| GET | `/checkout/session/:id` | Session (refresh-safe) |
| PATCH | `/checkout/session/:id` | `{ email?, phone?, addressId? \| address?, saveAddress?, shippingMethod?, couponCode? (null clears), pointsToRedeem? }`; clears the quote. Errors: `PINCODE_NOT_SERVICEABLE`, `SHIPPING_METHOD_UNAVAILABLE`, `COUPON_*`, `POINTS_INSUFFICIENT` |
| POST | `/checkout/session/:id/quote` | Final quote (lines, totals, hash, 10-min expiry); an inapplicable coupon shows as `couponError` |
| POST | `/checkout/place-order` ♻︎ | `{ sessionId, quoteHash }` → 201 `{ order }`. `QUOTE_CHANGED` (details: `changes`, fresh `quote`), `QUOTE_EXPIRED`, `SKU_OUT_OF_STOCK`, `COUPON_*`. A 4xx is replayed for the same key — send a new key to retry |
| POST | `/payments/attempts` ♻︎ | `{ orderNumber, method }` → 201 `{ attempt, gatewayUrl }`. `ORDER_NOT_PAYABLE`, `PAYMENT_IN_PROGRESS` |
| GET | `/payments/attempts/:id` | `{ attempt, order: { status, canPay, … } }` for the processing page |
| POST | `/payments/webhook` | Signed gateway callbacks |
| GET/POST | `/payments/sim/:gatewayRef[/submit]` | Simulated gateway page data / outcome |

## Orders, returns, refunds
| Method | Path | Purpose |
|---|---|---|
| GET | `/orders` 🔑 | History (expired unpaid orders hidden) + `claimable` count |
| GET | `/orders/:orderNumber` | Detail + timeline (owner, guest device, or `?token=`) |
| POST | `/orders/lookup` | Guest lookup (order number + email, 10/min) → `{ orderNumber, token }` |
| POST | `/orders/:orderNumber/cancel` ♻︎ | `{ itemIds?, reason }` — whole order or whole lines, before SHIPPED → `{ order }`. `ORDER_NOT_CANCELLABLE`. Owner, guest device or `?token=` |
| GET | `/orders/:orderNumber/invoice` | GST tax invoice, printable HTML (paid sale orders, CONFIRMED→DELIVERED) |
| GET | `/orders/:orderNumber/return-options` | Per item: returnable + reason, exchange options (same product, same price); window; `pointsRefundAllowed` |
| POST | `/returns` ♻︎ | `{ orderNumber, kind: return\|exchange, items: [{ orderItemId, reason, comment?, exchangeSkuId? }], refundDestination }` → 201 `{ return }`. `RETURN_WINDOW_CLOSED`, `RETURN_NOT_ELIGIBLE`, `EXCHANGE_UNAVAILABLE` |
| GET | `/returns` 🔑, `/returns/:rmaNumber` | List (members) / detail incl. timeline + refund (owner, guest device or `?token=`) |
| POST | `/returns/:rmaNumber/cancel` | Before pickup (`CONFLICT` after) |
| POST | `/orders/claim` 🔑 | Claim paid guest orders matching the verified email → `{ claimed }` |

## Engagement
| Method | Path | Purpose |
|---|---|---|
| POST/PATCH/DELETE | `/reviews[/:id]` 🔑 | Create `{ orderItemId, rating, title, body, fit? }` (delivered, kept line). `REVIEW_NOT_ELIGIBLE`, `CONFLICT` if already reviewed |
| POST | `/reviews/:id/helpful` 🔑 | `{ helpful: boolean }` → `{ helpfulCount, votedHelpful }`; not on your own |
| GET | `/reviews/eligible` 🔑, `/reviews/mine` 🔑 | Lines awaiting review / my reviews |
| POST | `/alerts/price` | `{ colorwayId, email? }` price-drop alert (guests give an email) |
| GET | `/notifications?cursor=` 🔑 | `{ notifications, unreadCount, nextCursor }` (30 per page) |
| POST | `/notifications/read` 🔑 | `{ ids }` or `{ all: true }` → `{ unreadCount }` |
| GET/PUT | `/notifications/preferences` 🔑 | Per kind `{ inApp, email }`; email is locked on for order/payment/refund/return/account |
| GET | `/loyalty` 🔑 | Balance, pending, expiring within 30 days, ledger (100 latest), personal coupons |
| GET | `/referrals` 🔑 | Code, link, invite statuses |
| GET | `/referrals/:code` | Public: validate referral code |

## Dev simulation (`SIMULATION_TOOLS=true` only)
| Method | Path | Purpose |
|---|---|---|
| POST | `/dev/catalog/import` | Run the catalog import on the live server `{ dryRun?, reprice?, resetStock? }` |
| POST | `/dev/clock/advance` | Fast-forward app clock |
| POST | `/dev/orders/:orderNumber/advance` | Perform the next fulfilment step now |
| POST | `/dev/returns/:rmaNumber/advance` | Perform the next return step now (picked up → received → inspected + completed) |
| POST | `/dev/skus/:skuCode` | Change price / stock / status (restock triggers back-in-stock alerts) |
| POST | `/dev/coupons/:code/expire` | Coupon ends now |
| POST | `/dev/points/grant` | `{ email, points }` available points (earning starts in Phase 5) |
| GET | `/dev/orders/:orderNumber` | Order + events, attempts, gateway charges, webhooks, reservations, coupon, points, refunds |
| POST | `/dev/refunds/failure-mode` | `{ failures }` — the gateway fails the next N refund requests |
| GET | `/dev/emails` | Sent-email outbox |
