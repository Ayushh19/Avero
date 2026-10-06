# AVERO — Frontend Routes

All routes are client-side (React Router). Filter/sort/pagination state lives in the URL query string.

## Discovery
| Route | Page |
|---|---|
| `/` | Home |
| `/c/*` | Category PLP, e.g. `/c/men/running` |
| `/collections/:slug` | Collection PLP |
| `/search?q=` | Search results PLP |
| `/p/:productSlug/:colorSlug` | Product details for a colorway (shareable per colour) |
| `/size-guide` | Size guide (also opens as modal from PDP) |

## Purchase
| Route | Page |
|---|---|
| *(drawer)* | Mini-bag, opens on add-to-bag without navigation |
| `/bag` | Full bag: lines, issues, save for later, coupon preview, FBT |
| `/checkout` | Single-page checkout: contact → address → delivery → review |
| `/checkout/pay/:attemptId` | Dummy payment gateway page |
| `/checkout/processing/:attemptId` | "Confirming payment…" — polls server, refresh-safe |
| `/order/confirmed/:orderNumber` | Order confirmation |

## Auth
| Route | Page |
|---|---|
| `/signup` | Create account |
| `/signin` | Sign in (email/password + Google) |
| `/auth/google/callback` | Handled by API, redirects back to web |
| `/verify-email?token=` | Email verification |
| `/forgot-password`, `/reset-password?token=` | Password reset |

## Account (signed in)
| Route | Page |
|---|---|
| `/account` | Overview |
| `/account/profile` | Profile, password, sessions |
| `/account/addresses` | Address book |
| `/account/orders` | Order history |
| `/account/orders/:orderNumber` | Order detail, tracking timeline, actions |
| `/account/orders/:orderNumber/return` | Return / exchange request |
| `/account/returns/:rmaNumber` | Return / exchange / refund status |
| `/account/wishlist` | Wishlist (guests: `/wishlist`, local) |
| `/account/rewards` | Points balance + ledger |
| `/account/referrals` | Referral code + invite status |
| `/account/notifications` | Notification centre + preferences |
| `/account/reviews` | My reviews + awaiting review |
| `/account/reviews/new/:orderItemId`, `/account/reviews/:id/edit` | Write / edit a review (star rating, fit, title, text) |

## Guest & utility
| Route | Page |
|---|---|
| `/track` | Guest order lookup (order number + email) |
| `/orders/:orderNumber?token=` | Guest order view via signed link |
| `/r/:code` | Referral landing |
| `/help`, `/help/:topic` | Shipping, returns, FAQ, contact |
| `/dev/simulation` | Dev-only simulation panel (`SIMULATION_TOOLS=true`) |
| `*` | 404 |
