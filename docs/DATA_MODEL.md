# AVERO — Data Model

Source of truth: `apps/api/src/db/schema/*.ts` (Drizzle). This document explains intent. Money is integer **paise**; timestamps are `timestamptz` UTC; primary keys are UUIDv7 unless noted.

## Catalog hierarchy

```
Product (style)            "AVERO Drift Runner"
 ├─ attributes             gender, activity, material, closure, drop, weight… (jsonb)
 ├─ Colorway (variant)     "Bone / Olive"  — own slug, images, status
 │    └─ SKU               UK 9            — own price, inventory, status
 └─ Category (tree) + Collections
```

- **Colorway** = what the user *looks at* (PLP card, PDP URL, images).
- **SKU** = what the user *buys* (price, stock).
- Product/colorway/SKU each have `status: draft | active | discontinued`. A SKU is purchasable only if all three are `active`.

## Tables

### Identity
| Table | Key columns | Notes |
|---|---|---|
| `users` | email (unique, lowercased), email_verified_at, password_hash?, name, phone?, preferred_size?, referral_code (unique), referred_by_user_id? | password_hash null for Google-only accounts |
| `oauth_accounts` | user_id, provider, provider_account_id | unique (provider, provider_account_id) |
| `sessions` | token_hash (unique), user_id, expires_at, last_seen_at, user_agent, ip, revoked_at? | |
| `auth_tokens` | user_id, purpose (`verify_email`/`reset_password`), token_hash, expires_at, used_at? | single use |
| `addresses` | user_id, full_name, phone, line1, line2?, landmark?, city, state, pincode, is_default | one default per user (partial unique index) |

### Catalog
| Table | Key columns | Notes |
|---|---|---|
| `categories` | parent_id?, slug, name, path (e.g. `men/running`), position | path unique |
| `products` | external_id (unique), slug (unique), name, description, category_id, gender, attributes jsonb, size_chart_id?, gst_rate_bps, status, rating_avg, rating_count, fit_* counts, search_vector | aggregates maintained on review write |
| `colorways` | product_id, external_id?, slug (unique per product), name, color_family, hex?, status, position | |
| `colorway_images` | colorway_id, url (1024px original), thumb_url (400px), medium_url (640px), alt, position, width?, height? | Variants made with sharp (`lib/media.ts`) |
| `skus` | colorway_id, sku_code (unique), size_label, size_sort, price_paise, mrp_paise, status, on_hand, reserved, low_stock_threshold, max_per_order | `CHECK on_hand >= 0`, `CHECK reserved >= 0`, `CHECK on_hand >= reserved`, `CHECK price_paise <= mrp_paise` |
| `size_charts` | name, rows jsonb (UK/IND, US, EU, cm), guidance | |
| `collections` | slug, name, description, kind (`manual`/`rule`), rules jsonb, hero_image?, position, starts_at?, ends_at?, active | |
| `collection_items` | collection_id, colorway_id, position | manual collections |
| `price_history` | sku_id, old_price_paise, new_price_paise, changed_at | drives price-drop alerts |

### Inventory
| Table | Key columns | Notes |
|---|---|---|
| `inventory_reservations` | sku_id, order_id?, return_request_id?, qty, status (`active`/`committed`/`released`), expires_at | |
| `inventory_movements` | sku_id, delta_on_hand, delta_reserved, reason, ref_type, ref_id | append-only audit of every stock change |

### Bag, wishlist, history
| Table | Key columns | Notes |
|---|---|---|
| `carts` | user_id? (unique), guest_token_hash? (unique), version, status (`active`/`merged`/`converted`) | exactly one of user_id / guest_token_hash |
| `cart_items` | cart_id, sku_id, qty, saved_for_later, price_seen_paise | unique (cart_id, sku_id, saved_for_later); price_seen detects price changes |
| `wishlist_items` | user_id, colorway_id, sku_id? | unique (user_id, colorway_id) |
| `recently_viewed` | user_id, colorway_id, viewed_at | unique (user_id, colorway_id); capped at 20 |
| `stock_alerts` | user_id? / email, sku_id? / colorway_id, kind (`back_in_stock`/`price_drop`), baseline_price_paise?, notified_at? | |

### Promotions & loyalty
| Table | Key columns | Notes |
|---|---|---|
| `coupons` | code (unique, uppercased), kind (`percent`/`flat`/`free_shipping`), value, max_discount_paise?, min_order_paise, starts_at, ends_at, usage_limit?, per_user_limit, used_count, first_order_only, eligible_category_ids, eligible_collection_ids, active | `CHECK used_count <= usage_limit` |
| `coupon_redemptions` | coupon_id, order_id (unique), user_id?, email, status (`active`/`released`) | |
| `points_ledger` | user_id, delta, kind (`earn`/`redeem`/`reverse`/`expire`/`bonus`/`referral`/`refund_credit`), status (`pending`/`available`/`void`), order_id?, available_at?, expires_at? | balance = sum of available |
| `referrals` | referrer_user_id, referee_user_id (unique), status (`signed_up`/`ordered`/`rewarded`/`void`), qualifying_order_id? | |

### Checkout, orders, payments
| Table | Key columns | Notes |
|---|---|---|
| `checkout_sessions` | cart_id, user_id?, email, phone, address jsonb, shipping_method, coupon_code?, points_to_redeem, quote jsonb, quote_hash, quote_expires_at, status, order_id? | |
| `orders` | order_number (unique), user_id?, email, phone, status, address jsonb, shipping_method, subtotal/discount/shipping/points_discount/total_paise, tax_paise (included), paid_paise, refunded_paise, guest_token_hash?, checkout_session_id (unique), placed_at, expected_delivery_at, delivered_at?, return_window_ends_at?, cancelled_at?, version | `CHECK refunded_paise <= paid_paise` |
| `order_items` | order_id, sku_id, product/colorway/size/image snapshots, unit_price_paise, mrp_paise, qty, discount_paise, total_paise, gst_rate_bps, status | snapshot never changes |
| `order_events` | order_id, order_item_id?, type, from_status?, to_status?, occurred_at, meta jsonb | drives tracking timeline |
| `shipments` | order_id, carrier, tracking_number, status, kind (`forward`/`return_pickup`/`exchange`) | |
| `payment_attempts` | order_id, amount_paise, method, status, scenario?, gateway_ref (unique), expires_at, idempotency_key (unique) | at most one `succeeded` per order (partial unique index) |
| `payment_events` | event_id (unique), attempt_id, type, payload, received_at, processed_at? | webhook dedupe |
| `refunds` | order_id, return_request_id?, amount_paise, destination (`original`/`points`), status, attempts, failure_reason?, idempotency_key (unique) | |
| `return_requests` | rma_number (unique), order_id, user_id?, kind (`return`/`exchange`), status, refund_destination, created_at | |
| `return_items` | return_request_id, order_item_id, qty, reason, comment?, exchange_sku_id? | |

### Engagement
| Table | Key columns | Notes |
|---|---|---|
| `reviews` | product_id, colorway_id, user_id, order_item_id, rating 1–5, title, body, fit (`small`/`true`/`large`), helpful_count, status | unique (user_id, product_id) |
| `review_votes` | review_id, user_id | unique pair |
| `notifications` | user_id, kind, title, body, link, read_at? | |
| `notification_preferences` | user_id, kind, in_app, email | |

### Infrastructure
| Table | Notes |
|---|---|
| `jobs` | queue + outbox (see ARCHITECTURE.md) |
| `idempotency_keys` | key + scope (unique), request_hash, status, response_status, response_body, expires_at |
| `sent_emails` | dev outbox: to, subject, html, text, created_at |
| `search_queries` | anonymised query log for trending searches |
| `app_clock` | single row offset for simulation time travel |

## Snapshots & immutability
Orders copy everything needed to render them (names, colour, size, image, prices, address). Catalog edits, discontinuation or price changes never alter past orders.

## Catalog import mapping (pending API details)
The importer maps the external SKU API into categories → products → colorways → images → SKUs, upserting by `external_id`/`sku_code`. It is idempotent and re-runnable, never overwrites inventory once set unless `--reset-stock` is passed, and rehosts/caches image URLs.
