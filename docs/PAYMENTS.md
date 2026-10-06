# AVERO — Simulated Payment Gateway

No real money moves and no card data is stored or even sent to our backend. The "gateway" is a module inside the API (`modules/payments/gateway-sim`) that behaves like a third-party hosted gateway: it has its own page, its own references, and talks back to our order system only through **signed webhooks** — exactly like a real integration.

## Flow

```
Checkout review ──POST /checkout/place-order (Idempotency-Key)──► Order PENDING_PAYMENT + stock reserved
        │
        └─POST /payments/attempts (Idempotency-Key)──► PaymentAttempt CREATED, gateway_ref
                 │
                 ▼
     /checkout/pay/:attemptId   (gateway page: UPI | Card | Net banking + scenario)
                 │  POST /payments/sim/:gatewayRef/submit { scenario }
                 ▼
     Gateway schedules webhook job(s) ──► POST /payments/webhook (HMAC signed, event_id)
                 │                                   │
                 ▼                                   ▼
     Redirect to /checkout/processing/:attemptId   Order/payment state updated transactionally
     (polls GET /payments/attempts/:id)            → reservation committed / released
                                                   → notifications + emails enqueued
```

The browser redirect and the webhook are independent. The order is only ever updated by the webhook handler (or reconciliation job), never by the redirect.

## Scenarios

| Scenario | Gateway behaviour | Final state |
|---|---|---|
| `success` | webhook `payment.succeeded` after ~1 s | SUCCEEDED → order PAID → CONFIRMED |
| `failure_declined` | webhook `payment.failed` (`card_declined`) | FAILED |
| `failure_insufficient` | webhook `payment.failed` (`insufficient_funds`) | FAILED |
| `pending` | webhook `payment.pending`, then `succeeded` or `failed` after N s (configurable) | eventual |
| `cancelled` | user clicks "Cancel payment" → `payment.cancelled` | CANCELLED |
| `timeout` | no webhook; reconcile job marks EXPIRED when attempt TTL passes | EXPIRED |
| `success_no_redirect` | webhook sent, browser redirect intentionally dropped (simulates closed tab) | SUCCEEDED |
| `duplicate_webhook` | same `payment.succeeded` event delivered 3× | SUCCEEDED once |
| `late_success` | success webhook arrives after reservation expiry | re-reserve or PAID_UNFULFILLABLE → auto refund |

Card tab accepts any well-formed test number (Luhn-checked client-side only) — the fields are **never submitted**; only the chosen scenario is posted. UPI tab shows a "Approve in your UPI app" waiting screen with a countdown.

## Guarantees
- **Idempotent attempt creation**: same `Idempotency-Key` → same attempt.
- **Single success**: partial unique index on `payment_attempts(order_id) WHERE status = 'SUCCEEDED'`.
- **Webhook dedupe**: `payment_events.event_id` unique; signature verified with `PAYMENT_WEBHOOK_SECRET`.
- **Monotonic states**: terminal states never change; out-of-order events are recorded but ignored.
- **Reconciliation**: `payment.reconcile` job queries the simulated gateway for attempts stuck in CREATED/PENDING and settles them.
- **Retry**: after FAILED/CANCELLED, user can retry → new attempt on the same order while its reservation is alive; otherwise the bag is intact for a fresh checkout.

## Implementation notes (Phase 3)
- **Code**: gateway `apps/api/src/modules/payments/gateway-sim/` (own table `gateway_sim_charges`); merchant side `modules/payments/service.ts`; order effects `modules/orders/lifecycle.ts`.
- **Attempt**: `POST /payments/attempts { orderNumber, method }` (♻︎). Allowed while the order is `PENDING_PAYMENT` / `PAYMENT_FAILED` and its reservation is alive. TTL = min(10 min, reservation expiry). An unsubmitted `CREATED` attempt is cancelled (`superseded`) when a new one is made; a submitted or `PENDING` one → `PAYMENT_IN_PROGRESS`. A retry moves the order `PAYMENT_FAILED → PENDING_PAYMENT`.
- **Webhook**: `X-Avero-Signature: t=<unix>,v1=hex(HMAC_SHA256(secret, "<t>.<raw body>"))`, 5-minute tolerance on the app clock; raw body parsed by a route-scoped parser. Body `{ id, type: payment.pending|succeeded|failed|cancelled, createdAt, data: { gatewayRef, merchantReference, amountPaise, failureReason? } }`. Event ids are stable per (charge, type), so a resend is the same event. Unknown payment → 404 (gateway retries); amount mismatch → recorded and ignored.
- **Delivery**: jobs `gateway.charge.settle` (bank answers) → `gateway.webhook.deliver` (signs and POSTs through the app's HTTP pipeline via `ctx.webhookTransport`; non-2xx retried with backoff).
- **Timings** (`business.payments`, simulated clock): webhook 1 s; `pending` resolves after 30 s (`pendingResolution: success|failure` in the submit body); `late_success` resolves 60 s after the order's reservation expiry; `timeout` never answers and expires at the attempt TTL.
- **Reconcile** (`payment.reconcile`, at attempt expiry + 60 s): gateway still processing → look again after its resolve time; settled → apply it; a success for an *expired* order is not applied here — reconciliation asks the gateway to redeliver the webhook (only the webhook may do `EXPIRED → PAID`).
- **Expiry** (`reservation.expire`, at placement + 15 min): unsubmitted attempts voided at the gateway and marked `EXPIRED`; order → `EXPIRED`; reservations, coupon and points released. Failed attempts before then leave everything held for a retry.
- **Success**: attempt `SUCCEEDED` → order `PAID` → reservations committed (`on_hand −= n`, `reserved −= n`, `sold_count += n`) → `CONFIRMED` with expected delivery; pending earn points; bag trimmed (BUSINESS_RULES 11a); confirmation email.
- **Late success**: `EXPIRED → PAID`; re-reserve + commit in a savepoint. Success → re-take coupon/points (honour the paid price if they can't be re-taken; recorded) → `CONFIRMED`. Stock gone → `PAID_UNFULFILLABLE → CANCELLED`, items `CANCELLED`, `refunds` row `INITIATED` for the full amount (processed by the Phase 4 refund flow), apology email.
- **Order access**: owner; the guest device that placed it (httpOnly `avero_guest` cookie, set when a guest starts checkout; `orders.guest_token_hash`); or a signed link `?token=<exp>.<hmac>` (30 days) from emails and `/orders/lookup`.

## Refunds
`POST` to the simulated gateway's refund endpoint from the `refund.process` job. Outcomes configurable via the dev simulation panel (succeed / fail N times) to exercise retry and points fallback.
