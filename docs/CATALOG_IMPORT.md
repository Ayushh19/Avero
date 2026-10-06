# AVERO — Catalog Import

Source: `SKU_API_URL` (SceneSKU public pack `shoes`, no key). The importer is the **only** code that talks to it. After import our database (and our copy of the images) is the source of truth; the storefront never calls the external API or CDN.

```bash
pnpm --filter @avero/api catalog:import            # import / refresh content
pnpm --filter @avero/api catalog:import --dry-run   # show what would change
pnpm --filter @avero/api catalog:import --reprice   # also overwrite prices from source
pnpm --filter @avero/api catalog:import --reset-stock
```

## Source shape (per item)
`id`, `state`, `visibility`, `categories[{name, slug}]`, `images[{id, index, title, image_url, thumbnail_url}]` (8 per item, 1024²/WebP), `product_data{product_title, short_description, long_description, bullet_points[], tags[], price (USD string), options{Color[], Size[]}}`.

Items with `state ≠ completed` or `visibility ≠ public` are skipped.

## Mapping

| Our field | Derived from |
|---|---|
| `products.external_id` | `id` |
| `name`, `slug` | `product_title`, slugified |
| `short_description`, `description`, `highlights` | `short_description`, `long_description`, `bullet_points` |
| `tags` | `tags` (lower-cased, de-duplicated) |
| `gender` | categories `mens-fashion` / `womens-fashion`, else title ("Women's…" before "Men's…"), else `unisex` |
| activity → category | first match on tags + title: running → `running`; training/fitness/gym → `training`; sneaker → `sneakers`; casual/canvas → `casual`; else `lifestyle` |
| category path | `<gender>/<activity>`, e.g. `women/running` (tree created on demand) |
| colorways | one per `options.Color`; external id `<id>:<colour-slug>` |
| colour family + swatch hex | keyword table (`grey/gray`, `pink`, `green`, `white`, `blue`, `purple`, …); multi-colour names → first family + blended hex |
| images | all source images, in source order, attached to the **first** colour only (source images are not per-colour; other colours are created as `draft` until they have imagery) |
| SKUs | one per colour × `options.Size`; code `AV-<6-char product hash>-<COL>-<size>`; `size_sort = size × 10` |
| price | USD × `USD_INR` (83) → rounded **up** to the next ₹100, minus ₹1 (`$65 → ₹5,399`) |
| MRP | = price, unless overridden in `merchandising.ts` |
| GST rate | 5% if unit price ≤ ₹2,500, else 18% (`business.gst`) |
| initial stock | deterministic from SKU code: ~10% sold out, ~20% low (1–4), rest 8–24. Recorded as `inventory_movements` (`reason = import`) |
| size chart | `Men footwear` / `Women footwear` by gender |
| `launched_at` | first import time |

## Images
Each image and thumbnail is downloaded once to `MEDIA_DIR/catalog/<source-image-id>[-thumb].webp` and served by the API at `/media/catalog/…` with immutable caching. Re-imports skip files that already exist. A failed download fails the import loudly (nothing half-imported is published).

## Re-import rules (our DB is the source of truth)
- **Refreshed every run:** names, descriptions, highlights, tags, category, images, new colours, new sizes.
- **Set only on first import:** price, MRP, stock, status. Use `--reprice` / `--reset-stock` to override.
- Sizes that disappear from the source → SKU `discontinued` (never deleted; orders reference them).
- Products missing from the source are reported, not deleted.

## Merchandising seed (`apps/api/src/modules/catalog/importer/merchandising.ts`)
Store-owned decisions that the source can't provide: a launch discount on one product (exercises MRP/sale UI), the curated **Best Sellers** collection, and rule-based collections (**New Arrivals**, **Running**, **Lifestyle**).

## Known limitations of the source
- 5 products, 1 colour each → colour swatches/facets are thin until the catalog grows.
- No ratings/reviews (correct: reviews come only from verified AVERO purchases).
- Size system unspecified; labels are shown as UK/IND.
