# AVERO — Product Specification (User Side)

AVERO is a fictional modern footwear and lifestyle brand (sneakers, running, casual and lifestyle shoes) sold through a complete, production-quality e-commerce web app. This document describes **what** the product does from the shopper's point of view. Business rules live in [BUSINESS_RULES.md](./BUSINESS_RULES.md), edge cases in [EDGE_CASES.md](./EDGE_CASES.md).

## Scope decisions

| Decision | Value |
|---|---|
| Market | India only — INR, GST-inclusive prices, 6-digit PIN codes, +91 phone numbers |
| Size system | UK/IND primary; US / EU / cm shown in size guide |
| Users | Shoppers only. **No admin side.** Operational actions are automated rules + seed scripts + a dev-only simulation panel |
| Accounts | Optional. Guests can browse, cart and check out |
| Auth | Create account (email + password, email verification), email sign-in, Google sign-in |
| Payments | Fully simulated gateway (UPI / Card / Net banking UI). No real money, no card data stored |
| Catalog source | External SKU API used **once** as import/seed source; our DB is the source of truth afterwards |
| Visual design | Defined separately in a design/UX markdown file (pending). Not assumed here |

## The user journey

```
Discover → Evaluate → Decide → Buy → Wait → Receive → After-purchase → Return visit
```

| Stage | What the user does | Surfaces |
|---|---|---|
| Discover | Lands, browses categories/collections, searches | Home, PLPs, search overlay |
| Evaluate | Filters/sorts, compares colours, checks size and reviews | PLP filters, PDP gallery, size guide, reviews |
| Decide | Picks colour + size, sees stock, adds to bag or wishlist | PDP, mini-bag drawer, wishlist |
| Buy | Reviews bag, applies coupon/points, enters address, pays | Bag, checkout, dummy gateway |
| Wait | Gets confirmation, tracks, may cancel | Confirmation, order detail + timeline, notifications |
| Receive | Order delivered, prompted to review | Notification → review form |
| After-purchase | Returns/exchanges, follows refund, earns points | Return/exchange flow, refund status, rewards |
| Return visit | Recommendations, recently viewed, wishlist alerts, referrals | Home rows, notifications |

**Guest path:** browse → bag → checkout with email + phone → confirmation → track via emailed link or `/track` lookup → optionally create an account later, which claims past guest orders with the same verified email.

## Features

### Discovery
- **Home** — merchandised blocks driven by DB collections (hero, featured collections, categories, new arrivals, bestsellers). Personal rows for returning visitors: recently viewed, picks from viewed categories, wishlist items back in stock.
- **Categories & collections** — category tree (e.g. Men › Running), curated or rule-based collections (e.g. "Trail Series", "Under ₹4,999").
- **Product listing (PLP)** — one card per **colorway**, swatches for sibling colours with image swap. Filters: category, size (only in-stock sizes), colour family, price range, gender, activity, rating, on sale, new. Sort: relevance, newest, price ↑/↓, bestselling, top rated. Facet counts. Filter state in URL (shareable, back/forward safe). Load-more pagination with scroll restoration.
- **Search** — debounced suggestions grouped into products (thumb + price), categories, collections and query completions. Recent searches (local), trending searches. Typo tolerance and synonyms ("trainers" → sneakers). Helpful no-results page.

### Evaluate & decide
- **Product details (PDP)** — image gallery (thumbs, zoom, swipe, fullscreen), colour switcher that updates URL and gallery without reload, size grid with availability states (available / "Only 2 left" / sold out → "Notify me"), price with MRP strike-through and discount %, delivery estimate by PIN code, returns/exchange policy snippet, details/specs accordion, rating summary with fit feedback, reviews list, "You may also like", "Frequently bought together".
- **Size guide** — per-product-type conversion chart (UK/IND, US, EU, cm) with how-to-measure guidance; preferred size pre-selected if saved.
- **Stock information** — server-derived badges; add-to-bag always re-validates stock on the server.
- **Wishlist** — colorway-level (optional size). Works for guests locally, merges on login. Drives back-in-stock and price-drop alerts.
- **Recently viewed** — local for guests (cap ~20), server for users, merged on login.

### Purchase
- **Bag (cart)** — line per SKU, quantity capped by stock and a per-SKU order limit, remove, save for later. Every view re-validates lines: OK / price changed (old → new) / low stock / quantity reduced / out of stock / discontinued. Guest bags persist server-side via an anonymous token. Totals always server-computed.
- **Coupons** — percentage, flat, free shipping. Min order value, eligible categories/collections, validity window, global and per-user limits, first-order-only. Precise rejection reasons.
- **Loyalty points redemption** — at checkout, capped to a percentage of the order value.
- **Checkout** — single page, progressive steps: contact → address → delivery method → review & pay. Saved addresses or new address with PIN serviceability check. Standard / Express with estimated delivery dates. Final server quote displayed before "Pay ₹X". Survives refresh.
- **Dummy payment** — hosted-gateway-style page with UPI / Card / Net banking tabs and explicit scenario outcomes. See [PAYMENTS.md](./PAYMENTS.md).
- **Order confirmation** — order number, items, totals, expected delivery, pending points, guest → "create account" prompt with email pre-filled.

### After purchase
- **Order history & detail** — status, vertical tracking timeline with timestamps, expected delivery date, dummy carrier + tracking number, GST invoice download.
- **Delivery lifecycle** — Order placed → Payment confirmed → Order confirmed → Packed → Shipped → Out for delivery → Delivered (simulated, time-compressed).
- **Cancellation** — whole order or individual items before *Shipped*. Reason picker. Refund auto-initiated.
- **Returns** — per item, within the return window after delivery. Reason + comment. Refund to original method or as AVERO points. Simulated pickup → received → inspected (auto-pass) → refunded.
- **Exchanges** — size or colour of the same product at the same price. New SKU reserved at request time. If unavailable, offered a return instead.
- **Refunds (dummy)** — Initiated → Processing → Completed / Failed (auto-retry, eventual fallback to points). Amount and destination visible.
- **Reviews & ratings** — verified purchasers of delivered items only, one per product. Stars, title, body, fit (runs small / true / large). Helpful votes.
- **Notifications** — in-app centre (bell + list) and email. Order/payment/refund events, back-in-stock, price drop, review prompt, points earned, referral reward. Per-category preferences.
- **Loyalty points** — earned on paid amount; *pending* until return window closes, then *available*; expire after a period; ledger visible. Small bonus for a review.
- **Referral** — personal code/link; referee gets a first-order discount; referrer earns points once the referee's first order clears its return window. No self-referral, new email/phone only.

### Account
- Create account, sign in (email or Google), email verification, forgot/reset password.
- Profile (name, email, phone, preferred size), password change, active sessions with "sign out other devices".
- Address book with default address.

### Utility & trust
- Guest order lookup (`/track`): order number + email.
- Help pages: shipping, returns & exchanges policy, FAQ, contact.
- 404 / error / offline-friendly states.

## Deliberately out of scope (for now)
Admin panel, multi-warehouse, multi-currency, marketplace sellers, gift cards, subscriptions, live chat, product comparison, COD.

## UX principles
- Fast feedback after every action; optimistic UI only where safe (wishlist, quantity, notifications read state) — never for stock-reserving or money-moving actions.
- Skeletons for loading, designed empty states, actionable error states.
- No unnecessary reloads; preserve state across navigation (filters, scroll, checkout form).
- Lazy-load images; responsive mobile → desktop.
- Never make users repeat information; never force account creation.
- Checkout must be simple and predictable: the price you see on the review step is the price you pay.
