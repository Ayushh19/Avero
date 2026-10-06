# AVERO — Roadmap

Each phase ends with something demoable and tested.

## Phase 0 — Foundations ✅ done
- [x] pnpm monorepo (`apps/api`, `apps/web`, `packages/shared`), TypeScript strict, ESLint/Prettier, Vitest
- [x] PGlite + Drizzle, full schema v1 (all domains), migrations incl. `pg_trgm`, seed (coupons, size charts)
- [x] Fastify app: env validation, error envelope, request IDs, CORS, cookies, rate limiting, CSRF header guard
- [x] Idempotency helper, simulated clock, money helpers (allocation, GST), shared state machines
- [x] DB-backed job queue + worker (outbox, retries/backoff, dedupe)
- [x] Mailer (console/SMTP + `sent_emails` outbox), dev routes (emails, clock)
- [x] Auth: sign-up, sign-in, sign-out, session list/revoke, email verification, password reset, Google OAuth (PKCE, safe linking), referral code capture
- [x] Web shell: router, query client, API client, auth pages + account placeholder (unstyled)
- [x] Tests: auth flows, idempotency, job queue, inventory constraints/last-unit race, money

## Design system ✅ done
- [x] `docs/DESIGN.md` + reference image (`docs/design/reference.png`)
- [x] Tokens, base styles, Inter + Manrope (self-hosted), Lucide icons
- [x] Components: buttons, form controls, radio cards, badges, swatches, size selector, quantity stepper, rating, price, stock, product media/card/grid, collection tile (arch), hero, editorial, trust row, tabs, accordion, breadcrumbs, stepper, order timeline, dialog, drawer, toasts, skeletons, empty/error states
- [x] Storefront chrome (announcement bar, header + mobile menu, footer), home page, auth pages, account dashboard + security (devices)
- [x] Dev gallery at `/dev/design`

## Phase 1 — Catalog & discovery ✅ done
- [x] SceneSKU importer (`docs/CATALOG_IMPORT.md`): normalisation, ₹ pricing, GST, deterministic stock, image rehosting, idempotent re-import, discontinued sizes
- [x] In-memory catalog index (listing, facets excluding own dimension, sorts) + live-stock PDP
- [x] Search: natural-language parser shared by web + API ("grey size 9", "under ₹5k"), pg_trgm typo tolerance, suggestions, trending, relaxations for empty results
- [x] Category / collection / search PLP with URL-state filters, chips, mobile filter drawer, load more
- [x] PDP: gallery + zoom viewer, colour & size with stock states, size guide, notify-me, delivery estimate by PIN, recommendations
- [x] Home driven by `/home` (hero, tiles, editorial, showcase), collections index
- [x] Dev endpoints: `POST /dev/catalog/import`, `POST /dev/skus/:skuCode` (price/stock/status simulation)

## Phase 2 — Bag & personal lists ✅ done
- [x] Guest (httpOnly token) + user bag, mini-bag drawer, bag page, save for later, free-shipping progress
- [x] Live line issues: unavailable / out of stock / insufficient stock / price changed (acknowledged once)
- [x] Optimistic concurrency (`expectedVersion` → 409 with fresh bag)
- [x] Merge on sign-in: bag (server, max-qty rule), wishlist & recently viewed (client → server)
- [x] Wishlist (device for guests, server for members, price-drop signal), back-in-stock alerts (email + notification job)
- [x] Recently viewed (device + server sync)
- [x] Profile (preferred size pre-selects PDP), password change/set, address book with PIN auto-fill & serviceability
- [x] Tests: 55 API tests incl. catalog import against the real payload and all bag edge cases

## Phase 3 — Checkout, payment, orders (core)
- Checkout session, quote, coupons, points redemption
- Reservations, idempotent order placement
- Simulated gateway, webhooks, reconciliation, processing page
- Confirmation, emails, order history, guest lookup/claim
- Concurrency & idempotency test suite

## Phase 4 — Fulfilment & post-purchase
- Delivery simulation + tracking timeline, invoices
- Cancellation (full/partial), returns, exchanges, refunds with failure/retry
- Notification centre + preferences

## Phase 5 — Engagement
- Reviews & ratings (verified), helpful votes
- Recommendations (You may also like, FBT, personal home rows)
- Back-in-stock & price-drop alerts
- Loyalty points, referrals

## Phase 6 — Hardening & polish
- Performance (image sizing, caching, code splitting), accessibility, SEO meta
- E2E tests (Playwright) for critical journeys
- Dev simulation panel UI
- Structured logging review, rate-limit tuning

## Notes
- Source catalog is 5 products × 1 colour; facets/recommendations are thin until it grows.
