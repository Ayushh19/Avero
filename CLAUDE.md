# AVERO — guidance for Claude

Full-stack e-commerce app for a fictional Indian footwear brand. User side only (no admin).

## Read first
- Status: Phases 0–5 are built (catalog, bag, checkout + simulated payments, orders, fulfilment, returns/exchanges/refunds, notifications, reviews, rewards, referrals, price alerts, recommendations). Phase 6 (hardening & polish, `docs/ROADMAP.md`) is next.
- `docs/PHASE_4_HANDOFF.md` — latest written snapshot (post-purchase); `docs/PHASE_3_HANDOFF.md` — checkout/payments detail. Later decisions live in `docs/BUSINESS_RULES.md` (e.g. 11a, 18–30a) and `docs/API.md`; no further handoff files are written.
- `docs/PRODUCT.md` — what we're building
- `docs/ARCHITECTURE.md` — stack, layout, conventions
- `docs/BUSINESS_RULES.md`, `docs/EDGE_CASES.md`, `docs/STATE_MACHINES.md` — invariants the backend must enforce
- `docs/DESIGN.md` — visual system and page compositions
- `docs/DATA_MODEL.md`, `docs/API.md`, `docs/PAYMENTS.md`, `docs/ROADMAP.md`

## Commands
- `pnpm install`
- `pnpm dev` — API (:3000) + web (:5173)
- `pnpm test` — all tests (Vitest)
- `pnpm typecheck`, `pnpm lint`
- `pnpm --filter @avero/api db:generate` — generate migration after editing schema
- `pnpm --filter @avero/api db:migrate` — apply migrations (also runs on API start)
- `pnpm --filter @avero/api db:seed`
- `pnpm --filter @avero/api db:seed-reviews` — sample verified reviews (or `POST /api/v1/dev/reviews/seed` while the API runs)

## Non-negotiables
- Never trust client prices; server computes all money in integer **paise**.
- Inventory: conditional updates + CHECK constraints; never negative.
- Retryable mutations use `Idempotency-Key`.
- State changes only through the transition maps in `packages/shared/src/states.ts`.
- Side effects (email, notifications, webhooks, timers) are enqueued as jobs inside the same transaction — never performed inside a transaction.
- Use the injectable clock (`lib/clock.ts`), never `new Date()` in business logic.
- Errors: throw `AppError(code, …)` with codes from `packages/shared/src/errors.ts`.
- PGlite = single process. Do not add clustering or a second DB connection.
- UI follows `docs/DESIGN.md`: use tokens from `apps/web/src/styles/tokens.css` and components from `apps/web/src/components/ui` (CSS Modules). No one-off colours, shadows on page content, or gradients. Check new components in `/dev/design`.
