# AVERO — Architecture

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + TypeScript, Vite, React Router, TanStack Query |
| Backend | Node 22 + TypeScript, Fastify |
| Database | PGlite (embedded Postgres, persisted to disk) via Drizzle ORM + drizzle-kit migrations |
| Validation | Zod schemas in `packages/shared`, used by both API and web |
| Jobs | DB-backed job queue (`jobs` table) + in-process worker loop |
| Search | Postgres full-text search + `pg_trgm` (typo tolerance, suggestions) |
| Email | Pluggable transport; dev default = console + `sent_emails` table viewable in dev panel; optional SMTP |
| Auth | Server-side sessions (httpOnly cookie), argon2 password hashing, Google OAuth 2.0 (authorization code + PKCE) |
| Package manager | pnpm workspaces |

## Repository layout

```
avero-ecommerce/
├─ apps/
│  ├─ api/                 Fastify API + worker (single process)
│  │  ├─ src/
│  │  │  ├─ db/            Drizzle schema, client, migrations runner, seed
│  │  │  ├─ lib/           errors, idempotency, money, ids, crypto, mailer, clock
│  │  │  ├─ plugins/       fastify plugins (auth/session, cart token, error handler)
│  │  │  ├─ jobs/          queue + worker + job handlers
│  │  │  └─ modules/       catalog, search, cart, auth, account, checkout,
│  │  │                    payments, orders, fulfilment, returns, refunds,
│  │  │                    reviews, recommendations, notifications, loyalty,
│  │  │                    referrals, simulation, importer
│  │  └─ drizzle/          generated SQL migrations
│  └─ web/                 Vite React app
│     └─ src/
│        ├─ app/           router, providers, layout
│        ├─ lib/           api client, query keys, local storage helpers
│        ├─ features/      feature folders mirroring API modules
│        └─ components/    shared UI primitives (styled once design arrives)
├─ packages/
│  └─ shared/              Zod schemas, DTO types, error codes, enums, money helpers
└─ docs/
```

Each API module owns: `routes.ts` (HTTP), `service.ts` (business logic, transactions), optional `repo.ts` (queries). Routes never contain business logic; services never touch `request`/`reply`.

## PGlite: implications & rules

PGlite is Postgres compiled to WASM running **inside the API process** with a single connection.

1. **One API process only.** No clustering / multiple instances. The job worker runs in the same process.
2. **Transactions are serialized** by PGlite. We still write code as if it were a concurrent multi-connection Postgres:
   - atomic conditional updates (`UPDATE … WHERE on_hand - reserved >= $n`)
   - `CHECK` and `UNIQUE` constraints as the last line of defence
   - idempotency keys on every retried mutation
   - `SELECT … FOR UPDATE` where read-then-write is required
   This keeps the codebase portable: swapping to `node-postgres` is a Drizzle driver change.
3. **Keep transactions short.** Never call external services (email, Google, simulated gateway timers) inside a transaction; enqueue a job instead.
4. **Data directory** configured by `DATABASE_DIR` (default `./.data/pglite`). Deleting it resets the database.
5. **Process lock**: every opener writes `<DATABASE_DIR>.lock` with its pid; a second process (CLI script while the API runs) is refused instead of corrupting data. Use the `/dev/*` endpoints for maintenance while the API is running.

## Catalog read path

- `CatalogIndex` (`modules/catalog/catalog-index.ts`) keeps an in-memory snapshot of purchasable colourways (prices, sizes + stock state, collections) with a 30 s TTL and explicit invalidation after imports/dev changes. Listing, facets and sorting run against it.
- Listing stock can be up to 30 s stale by design; PDP, bag and checkout always read live stock.
- Free-text search runs in Postgres (`pg_trgm` word similarity on `colorways.search_document`), then intersects with the in-memory filters.
- The query parser (`packages/shared/src/catalog/search.ts`) is shared: the web app turns typed queries into explicit URL filters (`q` keeps only unrecognised text, `qraw` the original), so every interpreted term is a visible, removable filter.

## Jobs (outbox pattern)

`jobs` table: `type, payload, run_at, status, attempts, max_attempts, dedupe_key, last_error, locked_at`.

- Jobs are inserted **inside the same transaction** as the state change that causes them → no lost side effects (acts as an outbox).
- Worker polls every ~500 ms, claims due jobs, runs handlers, retries with exponential backoff, marks `failed` after `max_attempts`.
- `dedupe_key` (unique while pending) prevents duplicate scheduling.
- Handlers must be idempotent.

Job types (planned): `reservation.expire`, `payment.resolve_pending`, `payment.reconcile`, `payment.webhook_deliver`, `fulfilment.advance`, `refund.process`, `points.confirm`, `points.expire`, `email.send`, `notification.fanout`, `stock_alert.check`, `referral.reward`.

## API conventions

- Base path `/api/v1`. JSON only. Request/response bodies validated with shared Zod schemas.
- **Error envelope**: `{ "error": { "code": "SKU_OUT_OF_STOCK", "message": "…", "details": {…} } }` with appropriate HTTP status. Codes enumerated in `packages/shared/src/errors.ts`.
- **Idempotency**: mutations that can be retried (`POST /checkout/place-order`, `POST /payments/attempts`, cancellations, return requests, refunds) require an `Idempotency-Key` header. Stored in `idempotency_keys` with a request hash; replay returns the stored response; same key + different body → `409 IDEMPOTENCY_KEY_REUSED`.
- **Optimistic concurrency**: carts carry a `version`; mutations may send `If-Match`-style `expectedVersion`; mismatch → `409 CART_VERSION_CONFLICT` with fresh cart.
- **Money**: integer paise everywhere (`price_paise`). Formatting only in the web app.
- **Time**: UTC timestamps; an injectable `clock` so the simulation panel can fast-forward.
- **IDs**: UUIDv7 primary keys; human-friendly `order_number` (`AV-2610-7K3QX`) and `rma_number`.

## Auth & identity

- **Sessions**: random 32-byte token in an httpOnly, `SameSite=Lax`, `Secure` (prod) cookie; only its SHA-256 hash stored in `sessions`. Sliding expiry. Revocable per device; all revoked on password change.
- **Guest identity**: separate `avero_cart` cookie carrying an anonymous cart token (hash stored). Wishlist/recently viewed for guests live in `localStorage` and are merged on sign-in.
- **Passwords**: argon2id.
- **Email verification / password reset**: single-use hashed tokens with expiry.
- **Google**: `GET /auth/google/start` → Google consent (state + PKCE verifier in short-lived signed cookie) → `GET /auth/google/callback` → find by `(provider, sub)`, else link to existing user **only if Google says `email_verified`**, else create user → session → redirect to `WEB_ORIGIN`.
- CSRF: API and web share a site; cookies `SameSite=Lax` + mutations require JSON content-type and an `X-Requested-With` header check.

## Frontend architecture

- TanStack Query for all server state (cache keys per resource, background refetch on focus — catches "bag changed on another device").
- Optimistic updates only for safe actions: wishlist toggle, bag quantity (with server reconciliation), notification read state.
- URL is the state for PLP filters/sort/page and PDP colour/size.
- Checkout form state persisted to `sessionStorage` + server checkout session.
- Image components lazy-load inside `aspect-ratio` boxes (no layout shift) and use `srcset` with 400 / 640 / 1024px sizes (`lib/images.ts`).
- Performance (Phase 6):
  - Pages are lazy route chunks (`app/router.tsx`); home and the layouts stay in the entry bundle. The listing, product and bag chunks are prefetched when the browser is idle. While a page's code loads, the layout still paints and the page area shows `PageFallback`.
  - For pages people land on from outside (`/p/…`, listings), an inline script generated at build time preloads the page chunk alongside the entry (`landingPreload` in `vite.config.ts`).
  - `@avero/shared` is `sideEffects: false`, so zod and the schemas load only on pages with forms. Keep zod-free constants out of `schemas/*` (e.g. `catalog/sort.ts`).
  - Fonts: Latin subsets only, preloaded, plus a ~1 KB ₹-only subset generated by `pnpm --filter @avero/web fonts:subset` (₹ otherwise pulls the 85 KB latin-ext file).
  - Images: sharp makes 400px and 640px WebP variants of each 1024px original at import. A background pass after API start-up (`lib/media.ts`) backfills older images. `/media` is served immutable for a year.
  - HTTP caching: public catalogue reads `public, max-age=30, stale-while-revalidate=60`; product detail and anything per-user `no-store`.

## Environment variables

| Var | Purpose |
|---|---|
| `PORT` | API port (default 3000) |
| `WEB_ORIGIN` | Web app origin for CORS + redirects (default `http://localhost:5173`) |
| `API_ORIGIN` | Public API origin (default `http://localhost:3000`) |
| `DATABASE_DIR` | PGlite data dir |
| `SESSION_SECRET` | Signing secret for short-lived signed cookies |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google sign-in |
| `SMTP_URL` | Optional; when absent, emails go to console + `sent_emails` |
| `PAYMENT_WEBHOOK_SECRET` | HMAC secret for simulated gateway webhooks |
| `SIMULATION_TOOLS` | `true` enables `/dev/*` endpoints and panel |
| `TIME_SCALE` | Delivery simulation speed factor |
| `SKU_API_URL`, `SKU_API_KEY` | External catalog source for the importer (pending) |
