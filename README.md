# AVERO

Full-stack e-commerce experience for AVERO, a fictional modern footwear & lifestyle brand (India / INR). User side only; payments are fully simulated.

## Docs
| Doc | What's in it |
|---|---|
| [docs/PRODUCT.md](docs/PRODUCT.md) | Vision, scope decisions, user journey, features |
| [docs/ROUTES.md](docs/ROUTES.md) | Frontend pages and routes |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, repo layout, PGlite rules, jobs, API conventions, auth, env vars |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Tables and their intent |
| [docs/API.md](docs/API.md) | API surface (v1) |
| [docs/STATE_MACHINES.md](docs/STATE_MACHINES.md) | Order / item / payment / return / refund transitions |
| [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md) | Invariants enforced by the backend + config values |
| [docs/EDGE_CASES.md](docs/EDGE_CASES.md) | Real-world edge cases and expected behaviour |
| [docs/PAYMENTS.md](docs/PAYMENTS.md) | Simulated gateway, scenarios, guarantees |
| [docs/CATALOG_IMPORT.md](docs/CATALOG_IMPORT.md) | SKU API → catalog mapping, pricing, re-import rules |
| [docs/DESIGN.md](docs/DESIGN.md) | Visual direction, tokens, components, page compositions |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases and status |

## Stack
React 19 + TypeScript (Vite, React Router, TanStack Query) · Node 22 + Fastify · Drizzle ORM + PGlite (embedded Postgres) · Zod (shared schemas) · pnpm workspaces · Vitest

## Getting started
```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # then set SESSION_SECRET / PAYMENT_WEBHOOK_SECRET
pnpm --filter @avero/api db:setup        # migrations + seed (coupons, size charts) + catalog import
pnpm dev                                 # API on :3000, web on :5173 (proxies /api and /media)
```
Open http://localhost:5173. The component gallery is at http://localhost:5173/dev/design (dev only).

### Google sign-in
Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` in `apps/api/.env`. In the Google Cloud console, add the redirect URI exactly as written in `GOOGLE_REDIRECT_URI` (e.g. `http://localhost:3000` or `http://localhost:3000/api/v1/auth/google/callback` — the API serves the callback at whichever path you choose; it must point at the API origin). The Google button only appears when these are set.

### Emails in development
Without `SMTP_URL`, emails (verification, password reset, …) are logged to the API console and stored; view them at http://localhost:5173/api/v1/dev/emails (requires `SIMULATION_TOOLS=true`).

## Scripts
| Command | Does |
|---|---|
| `pnpm dev` | Run API + web with reload |
| `pnpm test` | All test suites |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | Quality checks |
| `pnpm --filter @avero/api db:generate` | Generate a migration after editing `src/db/schema` |
| `pnpm --filter @avero/api db:migrate` | Apply migrations (also automatic on API start) |
| `pnpm --filter @avero/api db:reset` | Delete local DB, migrate, seed, import catalog |
| `pnpm --filter @avero/api catalog:import` | Re-import the catalog (API must be stopped; otherwise `POST /api/v1/dev/catalog/import`) |

## Layout
```
apps/api        Fastify API + in-process job worker, Drizzle schema & migrations
apps/web        React app
packages/shared Zod schemas, error codes, state machines, money helpers
docs/           Product & engineering specs
```
