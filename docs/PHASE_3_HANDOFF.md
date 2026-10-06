# Phase 3 Handoff — Checkout, Payments, Orders

State of the project at the end of Phase 2 (2026-10-06). Read with `CLAUDE.md`, `docs/BUSINESS_RULES.md`, `docs/EDGE_CASES.md`, `docs/STATE_MACHINES.md`, `docs/PAYMENTS.md`. Nothing is committed to git yet.

## 0. Phase 3 progress (updated 2026-10-06)
**Backend slices 1–7 done** (checkout, quote, coupons, points, reservations, place-order, simulated gateway, webhooks, reconcile, expiry, late success, orders API, guest access/claim, emails). **Web slices done** (§10.6). Tests: 112 API (+ `pricing`, `checkout`, `payments` suites) + 6 shared; web verified with Playwright scripts (not committed — no web test suite yet, Phase 6).

Web (`apps/web/src/features/checkout`, `features/orders`):
- `CheckoutLayout` (logo + secure note, no nav/footer) wraps `/checkout`, `/checkout/pay/:attemptId`, `/checkout/processing/:attemptId`.
- `/checkout`: Stepper + four step cards (contact → address → delivery → review & pay); completed steps collapse to a summary with Edit. State is server-side, so a refresh lands on the first incomplete step (or review when a quote is held). Summary sidebar: lines, coupon field (precise errors; invalid-coupon warning with Remove), points checkbox (members with a balance), live quote totals, "prices held until". Quote is fetched automatically whenever details are complete and re-fetched when it expires. Pay = place order (one Idempotency-Key per intent, renewed after a definite 4xx) → payment attempt → gateway. Handles `QUOTE_CHANGED` (lists the changes, button shows the new total), `QUOTE_EXPIRED`, stock-outs (link back to bag), coupon errors, and "already placed". Banner offers "Complete payment" for an order from this bag still awaiting payment. A new session for the same bag copies the previous contact/address/delivery.
- `/checkout/pay/:attemptId`: the simulated gateway's hosted page (test-mode badge, session countdown, UPI / card / net-banking fields validated in the browser only — never sent — and a scenario picker incl. pending → approved/declined). "Cancel payment" sends `cancelled`.
- `/checkout/processing/:attemptId`: polls the attempt; confirming (softer copy after 20 s), "not completed yet" (gateway says unsubmitted → back to payment), bank still processing (pending), failed/cancelled with one-click retry and reservation countdown, reservation ended, late-success-sold-out apology. Success → `/order/confirmed/:orderNumber`.
- `/order/confirmed/:orderNumber`, `/account/orders` (+ claim banner), `/account/orders/:orderNumber`, `/track`, `/orders/:orderNumber?token=` — shared `OrderDetail` (status card with "Complete payment" when payable, OrderTimeline, items, payment, delivery). Sign-up accepts `?email=` (guest "create account" prompt).
- Phase 4 actions (cancel, return, invoice) are not shown on order pages yet.

Decisions taken at kickoff (supersede §8–§10 where they differ):
- **Points (option b)**: redemption at checkout (≤ balance, ≤ 20% of subtotal after coupon; `redeem` row in the place-order transaction; reversed at expiry). Pending `earn` row on payment success = 1 point per ₹100 paid excluding shipping. Dev grant `POST /dev/points/grant`. Available-after-return-window → Phase 5; void on cancel/return → Phase 4.
- **`EXPIRED → PAID`** added to `ORDER_TRANSITIONS`, usable only by the payment webhook handler for a real late capture (`transitionOrder` enforces it). Reconciliation that finds such a success requests a webhook redelivery instead.
- **Late success + coupon/points**: re-claimed if possible; if the coupon filled up (or points were spent) the paid price is honoured and `coupon_honoured_over_limit` / `points_honoured_without_balance` is recorded.
- **Bag after payment**: purchased quantities subtracted from the bag (order snapshot; in-bag lines only; only on success). `carts.status = 'converted'` stays unused. See BUSINESS_RULES 11a.

Other choices made during the build:
- Coupon and redeemed points are **held through failed attempts** and released only at reservation expiry, so one-click retry keeps the same price.
- Attempt TTL = min(10 min, reservation expiry) (`business.payments`).
- New error codes: `CART_NOT_READY`, `SHIPPING_METHOD_UNAVAILABLE`, `PAYMENT_IN_PROGRESS`, `ORDER_NOT_PAYABLE`, `WEBHOOK_SIGNATURE_INVALID`.
- `POST /payments/attempts` takes `orderNumber` (not `orderId`).
- `free_shipping` coupons waive standard delivery only (`COUPON_NOT_APPLICABLE` with express). Free-shipping threshold is judged on the subtotal before discounts (same as the bag).
- Placing a second order from the same bag while one awaits payment is allowed; the session DTO exposes `pendingOrder` so the UI can offer "resume payment".
- Guest device ownership via httpOnly `avero_guest` cookie (set at checkout start); signed `?token=` links (30 days) for email and `/orders/lookup`. Claim is explicit (`POST /orders/claim`, verified email only).
- Coupon collection restrictions use materialised `collection_items` only (rule-based collections aren't matched). No seeded coupon uses restrictions.
- Order history hides `EXPIRED` (never-paid) orders.
- Migration `0004_gateway_sim` adds the simulated gateway's own table.

Code map: `modules/checkout` (service, pricing, routes), `modules/payments` (service, routes, `gateway-sim/`), `modules/orders` (lifecycle, service, access, routes), `modules/inventory/reservations.ts`, `modules/promotions/coupons.ts`, `modules/loyalty/points.ts`, `lib/transitions.ts`, `lib/requester.ts`. Shared DTOs/schemas: `packages/shared/src/schemas/checkout.ts`. Details in PAYMENTS.md §Implementation notes.

## 1. Stack & architecture
- **pnpm monorepo**: `apps/api` (Node 22, Fastify 5, TS 6), `apps/web` (React 19, Vite 8, React Router 8, TanStack Query 5), `packages/shared` (Zod 4 schemas, DTO types, error codes, state maps, money helpers, search parser — imported as TS source by both apps).
- **DB**: PGlite (embedded Postgres, single process) via Drizzle 0.45, `casing: 'snake_case'`. Migrations in `apps/api/drizzle/` (0000–0003), applied automatically on API start. `pg_trgm` enabled.
- **PGlite lock**: `openDatabase()` writes `<DATABASE_DIR>.lock` (pid). A second process (CLI) is refused while the API runs → use `/api/v1/dev/*` endpoints for maintenance. Never add a second DB connection or clustering.
- **App context** (`src/context.ts`): `{ env, db, clock, mailer, catalog }` decorated on Fastify as `app.ctx`; `app.worker` is the job worker.
- **Jobs** (`src/jobs`): DB `jobs` table + in-process worker polling every 500 ms; `enqueue(dbOrTx, type, payload, { runAt, dedupeKey, maxAttempts })` — call **inside the same transaction** as the state change (outbox). Backoff 5s×4ⁿ, max 30 min. Handlers registered in `jobs/handlers.ts`: `email.send`, `stock_alert.check`. Tests call `app.worker.runDue()`.
- **Clock**: `ctx.clock.now()` (SimulatedClock with persisted offset; `/dev/clock/advance`). Business logic must not use `new Date()`.
- **Errors**: `throw new AppError(code, message, details?)`; codes + HTTP status in `packages/shared/src/errors.ts` (already includes `QUOTE_CHANGED`, `QUOTE_EXPIRED`, `PINCODE_NOT_SERVICEABLE`, `COUPON_*`, `POINTS_INSUFFICIENT`, `PAYMENT_FAILED`, `SKU_OUT_OF_STOCK`, `SKU_UNAVAILABLE`, `IDEMPOTENCY_*`, `INVALID_STATE_TRANSITION`). Envelope: `{ error: { code, message, details?, requestId } }`. ZodError → `VALIDATION_FAILED` with `details: [{ path, message }]`.
- **Idempotency**: `withIdempotency(ctx, req, reply, scope, handler)` in `src/lib/idempotency.ts` — implemented and tested (`test/infra.test.ts`) but **not used by any route yet**. Requires `Idempotency-Key` header (8–128 `[A-Za-z0-9_-]`); stores 4xx results, releases on 5xx; same key + different body → `IDEMPOTENCY_KEY_REUSED`. Web helper: `newIdempotencyKey()` + `api.post(path, body, { idempotencyKey })`.
- **CSRF**: all non-GET requests need `X-Requested-With: avero` (web `api` client adds it). Exempt list in `plugins/session.ts`: only `/api/v1/payments/webhook` — keep that path for the simulated gateway webhook.
- **Dev servers**: API :3000, web :5173 (Vite proxies `/api` and `/media`). Static images served at `/media/catalog/*` from `MEDIA_DIR`.

## 2. Implemented so far
**Phase 0**: env validation, error envelope, CORS/cookies/rate limit, sessions, idempotency helper, jobs, mailer (console + `sent_emails`; view `/api/v1/dev/emails`), clock.
**Auth**: signup (name, email, optional phone, password, optional referralCode), signin, signout, email verify, resend, forgot/reset (reset revokes all sessions), session list/revoke, Google OAuth (PKCE; links to existing user only if Google says `email_verified`). Session cookie `avero_session` (httpOnly, Lax, 30-day sliding). `req.user` / `req.sessionId`; `requireUser(req)` throws `UNAUTHENTICATED`. Signup creates a `referrals` row (`signed_up`) when a valid code is given.
**Phase 1 (catalog)**: SceneSKU importer, catalog index, search, PLP/PDP/home/collections, delivery estimate. See `docs/CATALOG_IMPORT.md`.
**Phase 2**: bag, wishlist, recently viewed, back-in-stock alerts, profile/password, address book.
**Tests**: 55 API (`auth`, `infra`, `catalog`, `shopping`) + 6 shared. Helpers in `test/helpers.ts`: `createTestApp()` (in-memory DB, temp MEDIA_DIR), `client(app)` (cookie jar, CSRF header, `{ idempotencyKey }` option), `api(path)`. Catalog fixture `test/fixtures/scenesku-shoes.json`; import with `importCatalog(db, clock, { items, mediaDir, download: fake })`. `shopping.test.ts` has a `skuWith(stock)` helper.

## 3. Database (Drizzle schema in `apps/api/src/db/schema/`)
Money = integer **paise**; timestamps `timestamptz`; UUIDv7 ids.

| Area | Tables (key points) |
|---|---|
| identity | `users` (email unique lower-case, passwordHash nullable for Google-only, referralCode, referredByUserId), `oauth_accounts`, `sessions` (tokenHash), `auth_tokens`, `addresses` (one default per user via partial unique index) |
| catalog | `categories` (path e.g. `women/running`), `products` (externalId, slug, shortDescription, description, highlights[], tags[], gender, attributes.activity, gstRateBps, isFinalSale, status, rating aggregates, soldCount, launchedAt), `colorways` (status, colorFamily, hex, searchDocument + trgm index), `colorway_images` (url, thumbUrl, title, position), `skus` (skuCode, sizeLabel, sizeSort, pricePaise, mrpPaise, status, **onHand, reserved**, lowStockThreshold, maxPerOrder; CHECKs: onHand≥0, reserved≥0, reserved≤onHand, price≤mrp), `size_charts`, `collections` + `collection_items`, `price_history` |
| inventory | `inventory_reservations` (skuId, orderId?, returnRequestId?, qty, status active/committed/released, expiresAt) — **unused so far**; `inventory_movements` (append-only; reasons incl. `reserve`, `release`, `commit`, `restock_cancel`, `import`, `simulation`) |
| shopping | `carts` (userId XOR guestTokenHash; status active/merged/converted; `version`; `couponCode` column unused), `cart_items` (unique cart+sku+savedForLater; `priceSeenPaise`), `wishlist_items` (addedPricePaise), `recently_viewed`, `stock_alerts` |
| orders (**schema only, no code yet**) | `checkout_sessions` (cartId, userId?, email, phone, address jsonb, shippingMethod standard/express, couponCode, pointsToRedeem, quote jsonb, quoteHash, quoteExpiresAt, status open/order_placed/abandoned), `orders` (orderNumber unique, userId?, **checkoutSessionId unique NOT NULL**, status enum = `ORDER_STATUSES`, address jsonb snapshot, amounts: subtotal/discount/shipping/pointsDiscount/pointsRedeemed/total/tax/paid/refunded, couponCode, guestTokenHash, reservationExpiresAt, expectedDeliveryAt, deliveredAt, returnWindowEndsAt, version; CHECK refunded≤paid), `order_items` (full product/colour/size/image/price snapshots, discountPaise, pointsDiscountPaise, totalPaise, gstRateBps, status), `order_events`, `shipments`, `payment_attempts` (method upi/card/netbanking, status = `PAYMENT_STATUSES`, scenario, gatewayRef unique, idempotencyKey unique, expiresAt; **partial unique: one SUCCEEDED per order**), `payment_events` (eventId unique), `refunds`, `return_requests`, `return_items` |
| promotions | `coupons` (code, kind percent(bps)/flat(paise)/free_shipping, maxDiscountPaise, minOrderPaise, startsAt, endsAt, usageLimit, perUserLimit, usedCount CHECK ≤ usageLimit, firstOrderOnly, eligibleCategoryIds[], eligibleCollectionIds[], restrictedToUserId), `coupon_redemptions` (orderId unique, email, status active/released), `points_ledger` (unique earn/redeem per order), `referrals` |
| engagement | `reviews`, `review_votes`, `notifications` (used by stock alerts; no read API yet), `notification_preferences` |
| infra | `jobs`, `idempotency_keys`, `sent_emails`, `search_queries`, `app_clock` |

Seeded coupons (`db/seed.ts`, dates relative to seed time): `WELCOME10` (10%, max ₹500, min ₹1,499, first order), `FLAT500` (₹500 off ≥ ₹4,999, per-user 2), `FREESHIP`, `LAST3` (15%, usageLimit 3), `EXPIRED20` (expired).

## 4. Existing API (`/api/v1`)
System `GET /health`, `GET /config`. Auth `/auth/*` (see §2). Catalog: `GET /home`, `/categories`, `/collections`, `/products` (listing query in `listingQuerySchema`), `/products/:slug`, `/products/:slug/recommendations`, `/products/by-colorway?ids=`, `/search/suggest`, `/search/trending`, `GET /delivery/estimate?pincode=`, `GET /pincodes/:pincode`. Bag: `GET /cart`, `POST /cart/items`, `PATCH /cart/items/:id`, `DELETE /cart/items/:id`, `POST /cart/acknowledge-prices`. Wishlist/recent/alerts: `GET|PUT|DELETE /wishlist[/:colorwayId]`, `POST /wishlist/merge`, `GET|POST /recently-viewed`, `POST /alerts/stock`. Account: `PATCH /account/profile`, `POST /account/password`, `GET|POST|PUT|DELETE /account/addresses[/:id]`, `POST /account/addresses/:id/default`. Dev (`SIMULATION_TOOLS=true`): `GET /dev/emails`, `GET /dev/clock`, `POST /dev/clock/advance|reset`, `POST /dev/catalog/import`, `POST /dev/skus/:skuCode` (price/onHand/status; refuses onHand < reserved; restock enqueues stock alerts).

Module layout: `modules/<name>/routes.ts` (HTTP + Zod parsing) and `service.ts` (logic/transactions); register in `src/app.ts` inside the `/api/v1` prefix.

## 5. Bag behaviour (`modules/cart/service.ts`)
- Bag resolved by `resolveCart(ctx, req, reply, create)`: signed-in → active cart by `userId`; guest → `avero_cart` cookie (random token, sha256 stored), created lazily on first add (60-day cookie).
- Every mutation returns `{ cart: CartDto, notice? }`; web writes it straight into the `['cart']` query cache.
- `buildCartDto` re-validates every line live: issues `unavailable` (blocking), `out_of_stock` (blocking), `insufficient_stock` (non-blocking, line counted at `maxQty`), `price_changed` (non-blocking until `acknowledge-prices`). Blocking lines are excluded from totals; `hasBlockingIssues` disables checkout.
- `capFor` = min(onHand − reserved, maxPerOrder) when product, colourway and SKU are all `active`.
- Totals: subtotal at **current** price, MRP savings, standard shipping ₹99 unless subtotal ≥ ₹2,999, GST included (`includedGst` per line). No coupons/points in the bag (by design: applied at checkout).
- `version` bumps on every mutation; `PATCH` accepts `expectedVersion` → `CART_VERSION_CONFLICT` (409) with `details.cart` (fresh bag). Add/delete do not check version.
- Merge on sign-in (signin/signup/Google callback): guest lines folded into the user bag, same SKU → **max** qty (not sum) clamped to stock; guest cart → `merged`; cookie cleared; response `mergedBagLines`.
- Cart status `converted` exists for post-order use; nothing sets it yet.

## 6. Product / variant / inventory behaviour
- Product (style) → Colorway (what you see; own URL `/p/:productSlug/:colorSlug`) → SKU (size; what you buy). Purchasable only if all three `active`. Draft colourways are hidden; discontinued stay viewable but not purchasable.
- `available = onHand − reserved`. Nothing reserves stock yet — **Phase 3 introduces reservations** (rules: reserve at order placement, 15-min TTL, commit on payment success, release on fail/expiry; conditional `UPDATE … WHERE on_hand - reserved >= n`; write `inventory_movements`). The conditional-reserve pattern is already proven in `test/infra.test.ts` (last-unit race).
- `CatalogIndex` (listing/facets) is an in-memory snapshot with 30 s TTL; call `ctx.catalog.invalidate()` after stock changes that should show in listings. PDP, bag and (Phase 3) checkout must read live stock from the DB.
- Prices from import: USD×83 → ₹…99; GST 5% ≤ ₹2,500 else 18% (`business.gst`); per-SKU `maxPerOrder` 5, `lowStockThreshold` 5.

## 7. Frontend
- Routes (`apps/web/src/app/router.tsx`): `/`, `/c/*`, `/collections`, `/collections/:slug`, `/search`, `/p/:productSlug/:colorSlug?`, `/bag`, `/wishlist`, auth pages, `/account` (overview, profile, addresses, wishlist, recently-viewed, security + placeholders for orders/returns/reviews/rewards/referrals/notifications), `/dev/design` (dev only). **Placeholders**: `/checkout/*`, `/track`, `/help/*` → `ComingSoonPage`.
- Entry points into checkout already exist: `BagSummary` and mini-bag link to `/checkout`; PDP "Buy now" adds to bag then navigates to `/checkout`; guest bag page links `/signin?returnTo=/checkout`.
- UI kit (`components/ui`, CSS Modules, tokens in `styles/tokens.css`, rules in `docs/DESIGN.md`): `Button/ButtonLink/IconButton/ArrowLink`, `Field/SelectField/TextareaField/Checkbox/RadioCard/FormError`, `Badge/SwatchGroup/SizeSelector/QuantityStepper/Rating/PriceTag/StockIndicator`, `ProductMedia/ProductCard/ProductGrid/ProductRail/CollectionTile/Hero/EditorialSection/TrustRow`, `Tabs/Accordion/Breadcrumbs/`**`Stepper`**`/`**`OrderTimeline`**, `Dialog/Drawer/ToastProvider+useToast`, `Skeleton/ProductCardSkeleton/LoadingRegion/EmptyState/ErrorState`. Stepper, RadioCard and OrderTimeline were built for checkout/tracking.
- Reusable for checkout: `features/account/AddressForm.tsx` (props `initial`, `onSubmit`, `submitting`, `serverError`, `submitLabel`, `showDefault`, `onCancel`; PIN auto-fills state/city; flags unserviceable), `useAddresses()` in `features/account/sections.tsx`, `BagLine`, `BagSummary`, `FreeShippingProgress` (`features/bag/BagParts.tsx`), `useCart()` / `cartKey` (`features/bag/hooks.ts`), `useMe()`, `usePublicConfig()`, `savedPincode` local store (`lib/storage.ts`).
- Checkout should use a reduced header (logo + secure-checkout note) per DESIGN.md; current `Layout` always renders the full header — add a checkout layout.

## 8. Business rules & decisions Phase 3 must preserve
- Client never sends prices; server computes everything in paise. Order lines **snapshot** names/colour/size/image/prices/address.
- Final **quote** (id/hash/expiry, 10-min TTL) is what the shopper confirms; mismatch → `QUOTE_CHANGED` with diff, nothing charged.
- Discounts allocated to lines with `allocate()` (largest remainder) so lines sum exactly to totals.
- One checkout session → at most one order (unique `checkoutSessionId`); one order → at most one succeeded payment (partial unique index).
- `POST /checkout/place-order` and `POST /payments/attempts` require `Idempotency-Key` (use `withIdempotency`).
- Coupon redemption + `usedCount` increment inside the order transaction; released if the order fails/expires; one coupon per order; per-user/email limits; first-order-only.
- Webhooks HMAC-signed with `PAYMENT_WEBHOOK_SECRET`, deduped by `payment_events.eventId`, processed transactionally; terminal payment states never regress. The order is updated only by webhook/reconciliation, never by the browser redirect.
- All status changes go through the maps in `packages/shared/src/states.ts` and write `order_events`.
- Shipping: standard ₹99 (free ≥ ₹2,999, 3–6 days), express ₹199 (never free, 1–2 days, metro PINs only — `lookupPincode().express`). Unserviceable PIN → `PINCODE_NOT_SERVICEABLE`, re-checked at placement. Delivery dates from `estimateDelivery()` (IST, 14:00 cut-off, no Sundays).
- Guest checkout must work without an account (email + phone); guest order access via signed token / order number + email; verified sign-up can claim guest orders with the same email.
- Payment methods are simulated (UPI/Card/Net banking UI); card fields never leave the browser; nothing payment-related is stored beyond the scenario.
- Order number format `AV-YYMM-XXXXX` (`randomCode()` in `lib/crypto.ts`, Crockford base32).
- Never store payment details → no "Payment methods" account section.

## 9. Intentionally not implemented yet
Checkout, quotes, coupon application, inventory reservations, orders, payments/gateway/webhooks, order emails, order history/detail, guest order lookup/claim (Phase 3) · fulfilment simulation, tracking timeline data, cancellation, returns/exchanges, refunds, notification centre API/UI (Phase 4) · reviews, FBT, price-drop alerts, points earning/expiry, referral rewards (Phase 5) · E2E suite, SEO, perf pass (Phase 6). `carts.couponCode`, `points_ledger`, `referrals.status` beyond `signed_up` are unused.

## 10. Phase 3 scope
1. **Checkout session** API from the active bag: contact (email/phone; prefilled for members), address (saved address id or new snapshot; members may save it), shipping method, coupon code; refuses bags with blocking issues.
2. **Quote**: server-computed lines + subtotal, coupon discount, shipping, GST included, total; hash + 10-min expiry; precise coupon errors (`COUPON_EXPIRED`, `COUPON_NOT_STARTED`, `COUPON_LIMIT_REACHED`, `COUPON_MIN_NOT_MET`, `COUPON_NOT_APPLICABLE`, `COUPON_NOT_FOUND`).
3. **Place order** (idempotent): re-validate quote/stock/coupon/PIN in one transaction → reserve inventory (conditional updates + movements, 15-min TTL), create order + items (snapshots) + coupon redemption + `order_events`, order `PENDING_PAYMENT`, enqueue `reservation.expire`.
4. **Simulated gateway** per `docs/PAYMENTS.md`: `POST /payments/attempts` (idempotent), gateway page data + `submit { scenario }`, signed webhook delivery via jobs, `POST /payments/webhook`, `GET /payments/attempts/:id` for polling, `payment.reconcile` / timeout job. Scenarios: success, declined, insufficient funds, pending→resolve, cancelled, timeout, success-without-redirect, duplicate webhook, late success after reservation expiry (re-reserve or `PAID_UNFULFILLABLE` + auto-refund record).
5. **On success**: commit reservations, order `PAID → CONFIRMED`, cart → `converted` (new empty bag), coupon stays redeemed, confirmation email, invalidate catalog index. **On failure/expiry**: release reservations and coupon, bag intact, retry on same order while reservation is alive.
6. **Web**: checkout layout + `/checkout` (Stepper: contact → address → delivery → review & pay, state persisted across refresh), `/checkout/pay/:attemptId` (gateway page with scenario controls), `/checkout/processing/:attemptId` (polling, refresh-safe), `/order/confirmed/:orderNumber`, `/account/orders` + basic `/account/orders/:orderNumber`, guest `/track` lookup + signed `/orders/:orderNumber?token=` view, claim guest orders after verified sign-up.
7. **Tests**: idempotent placement/attempts, last-unit race between two checkouts, duplicate/out-of-order webhooks, coupon limits under concurrency, reservation expiry, price change → `QUOTE_CHANGED`, unserviceable PIN, refund-cap constraint.
8. **Decide at kickoff**: points redemption at checkout (schema ready, but no one can earn points until Phase 5 — likely defer).

## 11. Known issues & constraints
- Listing stock may be ≤30 s stale (by design); invalidate the index after reserve/commit/release.
- `search_queries.createdAt` uses DB `now()` while trending uses the simulated clock (only matters after time travel). `db/seed.ts` uses real `new Date()` for coupon windows.
- `jobs.runAt` default `new Date(0)` means "run now" regardless of simulated clock; scheduled jobs must pass `runAt` from `ctx.clock`.
- Google sign-in implemented and redirect verified, but not completed end-to-end with a real Google account.
- Source catalog is 5 products × 1 colour; facets/recommendations are thin.
- PGlite is single-process: concurrent requests are serialized at the DB, but code must still be written race-safe (conditional updates, unique constraints) for portability.
- Web app has no unit tests yet; visual checks were done with Playwright scripts (Playwright + Chromium installed as a root dev dependency).
- Local dev DB contains a few test accounts (`riya…@example.com`) from browser checks; `pnpm --filter @avero/api db:reset` rebuilds everything (re-downloads images only if `.data/media` was deleted).
