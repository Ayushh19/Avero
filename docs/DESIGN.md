# AVERO — Design & UX System

Visual reference: [`docs/design/reference.png`](./design/reference.png). Treat it as **direction, not a template**: AVERO keeps the same character (minimal, premium, editorial, image-led, soft neutrals, spacious, subtle) with its own identity.

Implementation lives in `apps/web/src/styles/tokens.css` (tokens), `apps/web/src/styles/base.css` (element defaults) and `apps/web/src/components/ui/*` (components, CSS Modules). A live gallery of every component is at `/dev/design` (dev only).

---

## 1. Principles

1. **Photography first.** Images are the loudest element; UI chrome is quiet.
2. **Breathe.** Generous section spacing, comfortable padding, controlled content width.
3. **Restraint.** Desaturated colour, few borders, almost no shadows, no gradients, minimal badges.
4. **Editorial rhythm.** Mix full-bleed, asymmetric and grid sections — never a wall of identical cards.
5. **Usability wins.** Pricing, availability, and the next action are always obvious. Style never hides state.
6. **Accessible by construction.** Contrast, focus, semantics and touch targets are built into the components.

## 2. Identity details (what makes it AVERO, not the template)

- **Wordmark**: `AVERO` set in Manrope 800, tracking `0.04em`.
- **The arch**: one tile per tile row uses an arched top (`--radius-arch`) — a signature shape echoing a shoe's heel counter. Use at most once per section.
- **Numbered carousel index** (`01  02  03`) instead of dots for the hero carousel. The home editorial block rotates on its own every 4.5 s with the hero's motion but shows no index or arrows (pauses on hover/focus).
- **Circular arrow button** as the editorial "read more" affordance.
- **Eyebrow labels**: tiny uppercase, wide tracking, above headlines (`NEW COLLECTION`).

## 3. Colour tokens

All colours are warm and desaturated. Never tint product photography.

| Token | Hex | Use |
|---|---|---|
| `--color-bg` | `#F6F4EF` | Page background (warm ivory) |
| `--color-surface` | `#FFFFFF` | Product cards, header, inputs, panels |
| `--color-surface-muted` | `#EFECE5` | Secondary sections, image placeholders (cream) |
| `--color-sand` | `#E6E0D5` | Beige sections, skeletons |
| `--color-sage` | `#C5C9B6` | Tile background |
| `--color-sage-deep` | `#7D8570` | Accents on sage |
| `--color-mist` | `#C3CDD6` | Tile background (dusty blue) |
| `--color-mauve` | `#CDBFBA` | Tile background (mauve/taupe) |
| `--color-ink` | `#1C1C1A` | Primary text, primary buttons, selected states |
| `--color-ink-2` | `#4A4843` | Secondary text |
| `--color-ink-3` | `#6B6860` | Metadata, captions (≥ 4.5:1 on bg) |
| `--color-border` | `#E4E0D8` | Hairlines, card borders |
| `--color-border-strong` | `#CBC6BB` | Input borders, size boxes |
| `--color-success` / `-bg` | `#3F6B4C` / `#E3ECE3` | In stock, delivered, discount amount |
| `--color-warning` / `-bg` | `#8A5A1F` / `#F3E8D6` | Low stock, payment pending |
| `--color-danger` / `-bg` | `#A13F35` / `#F5E3E0` | Errors, out of stock, failed |
| `--color-focus` | `#2F5D8A` | Focus ring |

Text on `--color-bg` / `--color-surface` must use `ink`, `ink-2` or `ink-3` only.

## 4. Typography

| Role | Font | Size / weight | Notes |
|---|---|---|---|
| Wordmark | Manrope | 20px / 800 | tracking 0.04em |
| Promo bar | Inter | 12px / 500 | |
| Eyebrow / label | Inter | 11px / 600, uppercase | tracking 0.14em |
| Navigation | Inter | 14px / 500 | |
| Hero headline | Manrope | `clamp(2.5rem, 5.2vw, 4.75rem)` / 500 | line-height 1.04, tracking −0.035em |
| Page title (h1) | Manrope | `clamp(1.75rem, 3vw, 2.5rem)` / 600 | tracking −0.02em |
| Section heading (h2) | Manrope | `clamp(1.5rem, 2.4vw, 2.125rem)` / 600 | |
| Card / product name | Inter | 15px / 600 | |
| Product metadata | Inter | 13px / 400, `ink-3` | colour name, counts |
| Price | Inter | 15px / 600, tabular numerals | PDP: 24px |
| Body | Inter | 15px / 400, line-height 1.6 | |
| Small / help | Inter | 13px / 400 | |

Prices always render through `formatINR` (`₹5,999`, Indian grouping). MRP is shown struck-through in `ink-3` with discount `%` in `success`.

## 5. Space, layout, radius, elevation, motion

- **Spacing scale** (4px base): `--space-1` 4 · `2` 8 · `3` 12 · `4` 16 · `5` 20 · `6` 24 · `8` 32 · `10` 40 · `12` 48 · `16` 64 · `20` 80 · `24` 96.
- **Section spacing**: `--section-gap: clamp(56px, 8vw, 112px)`.
- **Container**: max `1440px`, gutter `clamp(16px, 4vw, 48px)`. Reading width `680px`.
- **Grid gaps**: product grid `clamp(12px, 1.6vw, 24px)`.
- **Breakpoints**: `sm 640` · `md 768` · `lg 1024` · `xl 1280`.
- **Radius**: `--radius-sm 8px` (buttons, inputs, size boxes) · `--radius-md 14px` (cards, panels) · `--radius-lg 22px` (tiles, product media) · `--radius-xl 28px` (hero) · `--radius-arch` (elliptical: circular top on 4:5 surfaces, `22px` bottom corners) · `--radius-full` (swatches, circular buttons).
- **Elevation**: no shadows on page content. Only overlays use `--shadow-overlay` (drawer, dialog, toast, dropdown). Separation comes from background contrast and hairlines.
- **Motion**: `--ease-out: cubic-bezier(.2,.7,.2,1)`; durations `--dur-fast 150ms`, `--dur 250ms`, `--dur-slow 400ms`. Image hover: scale ≤ 1.03 or cross-fade to second image. Drawers slide 250ms. No bounce. `prefers-reduced-motion` disables transforms.

## 6. Components

All in `apps/web/src/components/ui`. Each is keyboard-accessible, labelled, and has loading/disabled states where relevant.

| Component | Notes |
|---|---|
| `AnnouncementBar` | 32px, centred small text, rotates messages (pause on hover/focus), uses `/config` values |
| `Header` | Logo left · nav centre (Men, Women, New Arrivals, Collections) · search field + wishlist/bag/account icons right. Sticky, white, hairline bottom. Mobile: menu trigger + logo + search + bag; nav moves into a drawer |
| `Footer` | Cream background, link columns (Shop, Help, About), newsletter field, legal row |
| `Button` | `primary` (ink bg, ivory text) · `secondary` (white/transparent, hairline border) · `ghost` · `link`. Sizes `sm 36` / `md 44` / `lg 52`. `loading` keeps width |
| `IconButton` | 40×40 min (44 on touch), circular or square variant, always `aria-label` |
| `ArrowButton` | Circular outlined arrow, editorial CTA |
| `Field` / `Input` / `Select` / `Textarea` | Label above, 48px height, `--radius-sm`, hairline border, focus ring, inline error below with icon |
| `Checkbox` / `Radio` / `RadioCard` | RadioCard = bordered selectable card (address, delivery method), selected = ink border |
| `Badge` | Small uppercase boxed label on white (`NEW`, `BESTSELLER`), tones: neutral, success, warning, danger |
| `Swatch` / `SwatchGroup` | 28px circles, selected = 2px ink ring with gap, sold-out = diagonal strike; `+N` overflow on cards |
| `SizeSelector` | Grid of 44px square boxes; selected = ink fill; low stock = small dot; unavailable = struck, still focusable for "Notify me" |
| `QuantityStepper` | `− 1 +` inline, bordered |
| `ProductCard` | White card `--radius-md`, media area with whitespace around shoe, badge top-left, wishlist heart top-right, name, colour description, swatches (+N), price/MRP, optional rating. Desktop hover: cross-fade to second image + quick add; mobile: no hover dependency |
| `ProductGrid` | 2 cols mobile · 3 tablet/desktop with filters · 4 wide without filters |
| `CollectionTile` | Large rounded tile on soft colour (`sage`, `mist`, `mauve`, `sand`), image, label + "Shop now →"; `arch` variant |
| `Hero` | Rounded `--radius-xl` media, eyebrow, headline, short copy, primary + secondary CTA, numbered index + arrow controls |
| `EditorialSection` | Asymmetric split (text + large image + secondary image), `ArrowButton` |
| `Breadcrumbs` | Small, `ink-3`, `/` separators |
| `Tabs` | Underline tabs (PDP: Description · Details · Reviews · Shipping & Returns) |
| `Accordion` | Hairline separated, chevron; used for filters and mobile PDP sections |
| `Rating` | Stars + numeric + count (`4.6 (320 reviews)`) |
| `PriceTag` | Price, optional MRP + discount |
| `StockIndicator` | Dot + text: in stock (success) · only N left (warning) · out of stock (danger) |
| `Drawer` | Native `<dialog>` side sheet (bag, mobile nav, mobile filters) |
| `Dialog` | Native `<dialog>` modal (size guide, quick view, confirmations) |
| `Toast` | Bottom-centre (mobile) / bottom-right (desktop) compact cards, `aria-live`, auto-dismiss, optional action |
| `Skeleton` | Sand-coloured blocks with slow shimmer, preserve final dimensions |
| `EmptyState` / `ErrorState` | Icon, one-line title, one sentence, single primary action |
| `Stepper` | Checkout progress: Bag · Address · Payment · Review with check circles |
| `OrderTimeline` | Horizontal (desktop) / vertical (mobile) progress with check circles in `success`, current step emphasised, timestamps beneath |
| `TrustRow` | Icon + two-line text items (free shipping, easy returns, warranty) |

## 7. Page compositions (from the reference)

**Announcement + header** on every storefront page. Checkout uses a reduced header (logo + secure-checkout note) — distraction-free.

**Home**
1. Hero (rounded, cinematic, eyebrow "NEW COLLECTION", headline e.g. "Modern comfort for your active life", CTAs Shop Men / Shop Women, numbered index)
2. Four collection tiles in soft colours (Best Sellers, New Arrivals, Men, Women) — one arch tile
3. Editorial split: "Sustainable comfort meets effortless style" + arrow button + lifestyle image
4. Product showcase with tabs (Featured / Men / Women)
5. Secondary editorial / collection banner
6. Recently viewed (if any)
7. Footer

Mobile recomposes: hero image above text, tiles 2×2, editorial stacked.

**Product listing** — breadcrumbs · title + product count · sort select top-right · left filter rail (accordions: Category checkboxes, Size grid, Colour swatches, Price range, Rating, Availability, Discount) · 3-column grid. Mobile: sticky "Filter & sort" bar opening a drawer; active filters as removable chips.

**Product detail** — vertical thumbnails + large media (desktop), swipe gallery with thumbnails (mobile) · name · price/MRP · rating · short description · "Colour: name" + swatches · "Size: 9" + size grid + Size guide link · stock indicator + ship estimate · Add to bag (primary, full width) + wishlist icon button · Buy now (secondary) · trust row · tabs · reviews · You may also like / Frequently bought together.

**Bag** — "Your bag (3 items)" · line rows (image, name, colour, size, stepper, price, remove, move to wishlist, issue banner per line) · summary panel (subtotal, discount in success, shipping, total, coupon field + Apply, Proceed to checkout, "or check out as guest").

**Checkout** — reduced header · stepper · address RadioCards with Edit + "Add new address" · delivery method RadioCards with fee/ETA · summary sidebar · single primary CTA per step.

**Order tracking** — "Order #AV-…" + placed date · status card (icon, current status, one-line explanation) · horizontal timeline · tracking details list · items · payment + address summary · actions (cancel / return / exchange / invoice).

**Account** — left nav (desktop) / card grid (mobile): Profile, Orders, Wishlist, Addresses, Returns, Reviews, Rewards, Notifications, Recently viewed, Security. *Payment methods is intentionally omitted — we never store payment details.*

**Rewards** — points balance, tier + progress bar, history list. Calm, not gamified.

## 8. States

- **Loading**: skeletons matching final layout; buttons show inline spinner and keep width; never blank the page on refetch.
- **Empty**: "Your bag is empty" + "Start shopping" — one line, one action.
- **Error**: plain-language cause + recovery action ("Try again", "Back to bag"). Never show raw codes; `requestId` only in a small "Reference" line for support.
- **Availability**: always text + colour (never colour alone).

## 9. Responsive rules

- Mobile first. Recompose, don't shrink: hero stacks, tiles go 2×2, filter rail becomes a drawer, PDP gallery becomes swipeable, summary panels move below content with a sticky CTA bar.
- Touch targets ≥ 44px. No hover-only functionality.

## 10. Accessibility checklist

Semantic landmarks (`header`, `nav`, `main`, `footer`) · skip link · visible `:focus-visible` ring (`--color-focus`, 2px + 2px offset) · labels on all inputs · `aria-live` for bag updates, toasts and form errors · dialogs/drawers via native `<dialog>` (focus trap + Esc) · `alt` text for meaningful images, empty `alt` for decorative · contrast ≥ 4.5:1 for text · reduced-motion respected.

## 11. Imagery

- Product media aspect ratio **1:1** on cards (shoe centred with ~12% padding), **4:5** on PDP main image, **16:9 → 4:5** hero (desktop → mobile).
- Always reserve space (`aspect-ratio`) to avoid layout shift; lazy-load below the fold; `fetchpriority="high"` on hero and PDP main image.
- Placeholder while loading: `--color-surface-muted` block.
- Until real catalog imagery is imported, components render soft-coloured placeholders.
