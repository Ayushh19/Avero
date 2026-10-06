# Phase 4 Handoff — Fulfilment & post-purchase

Read with `PHASE_3_HANDOFF.md` (stack, conventions, Phase 3 decisions), `BUSINESS_RULES.md`, `STATE_MACHINES.md`, `API.md`.

## 0. Progress (updated 2026-10-06)
**Backend and web done** (delivery simulation + tracking, invoices, cancellation, refunds with retry/points fallback, returns, exchanges, notifications + preferences). Tests: 134 API (`postpurchase.test.ts` adds 22) + 6 shared. Migration `0005_post_purchase`.

Kickoff decisions:
- **Delivery pace**: realistic dates on the simulated clock (match the expected-delivery date shown). Demo with `/dev/clock/advance` or `/dev/orders/:n/advance`. `TIME_SCALE` stays unused.
- **Exchange orders**: `orders.checkout_session_id` nullable; `orders.kind` (`sale` | `exchange`) + `parent_order_id`.
- **Whole lines only** for cancellations and returns.
- **Guests** can cancel/return via their device or a signed link; refunds to the original method only.

Choices made during the build (also in BUSINESS_RULES 18–27):
- Fulfilment schedule from confirmation: packed +3 h, shipped +18 h, out for delivery 08:00 IST and delivered 15:00 IST on the earliest promised day. A step processed late (after a clock jump) is recorded at its scheduled time, so delivery date and return window stay realistic.
- Returns are auto-approved and go straight to `PICKUP_SCHEDULED`: picked up next day 11:00 IST → received +2 days → inspected (auto-pass) +1 day → completed. Stock back on sale at inspection.
- Refunds: `refund.process` job calls the simulated gateway outside any transaction (claim → call → apply; gateway idempotent per refund+attempt). Backoff 5 min × 4ⁿ; after 3 failures members get points (⌈amount ÷ ₹1⌉), guests keep retrying every 6 h. Refund-to-points completes immediately. Cap: sum of an order's refund rows ≤ `paid_paise` under the order lock + the existing CHECK.
- Phase 3's late-sellout and duplicate-capture refunds now go through the same flow and actually complete. `refunds.reason` (`cancellation` | `return` | `unfulfillable` | `duplicate_capture`; existing rows backfilled) and `refunds.payment_attempt_id` added. Duplicate-capture refunds don't count towards the order's paid/refunded amounts.
- Shipping is refunded only when an order is fully cancelled before shipping; a coupon is released only then (it stays on a partial cancel even if the rest falls below its minimum — the refund is each line's allocated share).
- Pending earned points: the pending `earn` row is reduced to what the kept lines earn (voided when nothing is kept) rather than appending a reversal row.
- Notifications: one `notify()` (in-app row + email job in the caller's transaction). Preferences: in-app can be muted for every kind; email can be muted only for non-transactional kinds (stock alerts, price drops, review prompts, points, referral). Member back-in-stock emails now respect that preference. Packed is in-app only; shipped / out for delivery / delivered / cancelled / refund / return events also email.
- Invoice: printable HTML (no PDF dependency — "Print or save as PDF"), fictional GSTIN, CGST+SGST when delivering in Karnataka else IGST, shipping at 18 %, cancelled lines left out; only for paid sale orders from CONFIRMED on.
- Exchanges: "same price" = the target's current price equals the unit price paid; replacement items are not returnable/exchangeable and replacement orders can't be cancelled.
- Cancelling a return is allowed until pickup; after that → `CONFLICT`.

Code map: `modules/fulfilment`, `modules/orders/{cancellation,invoice}.ts`, `modules/refunds`, `modules/returns`, `modules/notifications`, gateway refunds in `modules/payments/gateway-sim`, transitions `transitionItems` / `transitionRefund` / `transitionReturn` in `lib/transitions.ts`, shared contracts in `packages/shared/src/schemas/postPurchase.ts` (+ `OrderDto` extended). Jobs: `fulfilment.advance`, `return.advance`, `refund.process`.

Dev endpoints: `POST /dev/orders/:n/advance`, `POST /dev/returns/:rma/advance`, `POST /dev/refunds/failure-mode { failures }`.

## Web
Verified in Chromium (Playwright scripts, not committed) against a throwaway in-memory API, desktop + 390 px.
- **Order detail** (`features/orders/PostPurchase.tsx`, used by account and guest order pages; guests keep `?token=` on every link): action row — *Return or exchange*, *Cancel order / Cancel items* (dialog: line picker when more than one, reason, refund + points preview, coupon note on partial cancels), *Invoice* (opens the HTML invoice), return-window note. Tracking panel (carrier, tracking number, newest event first), Refunds panel (amount, reason, destination, status incl. "Delayed — retrying"), Returns & exchanges panel, item badges (cancelled / in progress / returned / refunded / exchanged), "Free replacement from an exchange on order …" note on replacement orders.
- **Return / exchange request**: `/account/orders/:n/return` and guest `/orders/:n/return?token=` (`features/returns`). Choose return vs exchange, tick lines (ineligible ones disabled with the reason), reason + optional comment, exchange target (sold-out options disabled; lines with no same-price option can't be exchanged), refund destination (points disabled for guests). One Idempotency-Key per intent.
- **Returns**: `/account/returns` list; detail at `/account/returns/:rma` and guest `/returns/:rma?token=` — status card, progress timeline (pickup booked → … → refund issued / replacement created), items with reasons and exchange target, refund or replacement panel, cancel (with confirmation) until pickup.
- **Notifications**: bell in the header for members (unread badge, drawer with the latest 15, mark all as read, link to the centre); `/account/notifications` — full list (click marks read and follows the link) + preferences table (email checkbox locked for transactional kinds). Read state and preference toggles update immediately.
- Account placeholders for Returns and Notifications removed.
