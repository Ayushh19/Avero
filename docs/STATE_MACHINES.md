# AVERO — State Machines

All transitions are defined in code as explicit maps (`packages/shared/src/states.ts`) and enforced by the services. Any transition not listed is rejected with `INVALID_STATE_TRANSITION` and logged. Every transition writes an `order_events` row.

## Order

```
PENDING_PAYMENT ──► PAID ──► CONFIRMED ──► PACKED ──► SHIPPED ──► OUT_FOR_DELIVERY ──► DELIVERED
      │               │          │           │
      │               └──────────┴───────────┴──► CANCELLED        (before SHIPPED only)
      ├──► PAYMENT_FAILED  (terminal for this attempt; user may retry → new attempt, same order while reservation alive)
      └──► EXPIRED         (reservation/payment window elapsed)

PAID ──► PAID_UNFULFILLABLE ──► CANCELLED   (late payment success after stock lost → auto full refund)
EXPIRED ──► PAID                              (late payment success only — payment webhook handler only)
```

| From | Allowed to |
|---|---|
| PENDING_PAYMENT | PAID, PAYMENT_FAILED, EXPIRED |
| PAYMENT_FAILED | PENDING_PAYMENT (retry), EXPIRED |
| PAID | CONFIRMED, CANCELLED, PAID_UNFULFILLABLE |
| PAID_UNFULFILLABLE | CANCELLED |
| CONFIRMED | PACKED, CANCELLED |
| PACKED | SHIPPED, CANCELLED |
| SHIPPED | OUT_FOR_DELIVERY |
| OUT_FOR_DELIVERY | DELIVERED |
| EXPIRED | PAID — **only** from the payment webhook handler, for a payment the gateway reports as succeeded after the order expired (`transitionOrder(..., { latePaymentFromWebhook: true })`). Reconciliation that discovers such a success asks the gateway to redeliver the webhook instead. Otherwise terminal. |
| DELIVERED, CANCELLED | — (terminal; items continue via item states) |

User-facing timeline labels: Order placed → Payment confirmed → Order confirmed → Packed → Shipped → Out for delivery → Delivered.

## Order item

```
ACTIVE ──► CANCELLED
ACTIVE ──► (order DELIVERED) DELIVERED ──► RETURN_REQUESTED ──► RETURNED ──► REFUNDED
                                     └──► EXCHANGE_REQUESTED ──► EXCHANGED
```
| From | Allowed to |
|---|---|
| ACTIVE | CANCELLED, DELIVERED |
| DELIVERED | RETURN_REQUESTED, EXCHANGE_REQUESTED |
| RETURN_REQUESTED | RETURNED, DELIVERED (request cancelled) |
| RETURNED | REFUNDED |
| EXCHANGE_REQUESTED | EXCHANGED, DELIVERED (request cancelled) |

## Payment attempt

```
CREATED ──► PENDING ──► SUCCEEDED
   │           ├──────► FAILED
   │           ├──────► CANCELLED
   │           └──────► EXPIRED
   └──► (same terminal states)
```
Terminal states never change. A late `failed` event after `succeeded` is ignored (recorded as `payment_event_ignored`). An attempt is marked `EXPIRED` only when the gateway confirms nothing was captured, so a late success is always an attempt still in `CREATED`/`PENDING` whose *order* expired: the attempt goes `→ SUCCEEDED` and the order takes the late-success path (re-reserve → CONFIRMED, or PAID_UNFULFILLABLE → CANCELLED + refund).

Enforcement: `apps/api/src/lib/transitions.ts` (`assertTransition`, `transitionOrder`, `transitionOrderItems`, `transitionAttempt`) — conditional on the current status, and every order change writes `order_events`.

## Return / exchange request

```
REQUESTED ──► PICKUP_SCHEDULED ──► PICKED_UP ──► RECEIVED ──► INSPECTED ──► COMPLETED
    └──► CANCELLED (by user, before PICKED_UP)
```
- Return → `COMPLETED` triggers refund creation.
- Exchange → `INSPECTED` creates a zero-value replacement order for the reserved SKU, which follows the normal fulfilment lifecycle.
- No admin: approval is rule-based at creation; inspection auto-passes in simulation.

## Refund
Implemented in `modules/refunds` (Phase 4): backoff 5 min × 4ⁿ between attempts; `FALLBACK_TO_POINTS` after 3 failures for members (guests have no points: they stay `FAILED` and retry every 6 h). A refund paid as points (chosen at return) goes `INITIATED → PROCESSING → COMPLETED` immediately. On completion of a return's refund its items move `RETURNED → REFUNDED`.

```
INITIATED ──► PROCESSING ──► COMPLETED
                   └──► FAILED ──► PROCESSING (auto-retry, backoff)
                           └──► (after N failures) FALLBACK_TO_POINTS ──► COMPLETED
```

## Points ledger entry
`pending ──► available ──► (consumed by redeem) / void (reversed or expired)`
