import type { ImageDto, ListingItemDto, StockState } from '@avero/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  categories,
  collectionItems,
  collections,
  colorwayImages,
  colorways,
  products,
  skus,
  type CollectionRules,
} from '../../db/schema';
import type { Clock } from '../../lib/clock';
import { imageRole } from './images';

export interface IndexedSize {
  label: string;
  sort: number;
  state: StockState;
}

export interface IndexedItem extends Omit<ListingItemDto, 'badge' | 'swatches'> {
  productSlug: string;
  colorSlug: string;
  categoryPath: string;
  sizes: IndexedSize[];
  launchedAt: Date | null;
  soldCount: number;
  onSale: boolean;
  position: number;
  searchDocument: string;
}

export interface IndexedCategory {
  id: string;
  path: string;
  name: string;
  parentPath: string | null;
}

export interface IndexedCollection {
  id: string;
  slug: string;
  name: string;
  description: string;
  kind: 'manual' | 'rule';
  rules: CollectionRules | null;
  heroImageUrl: string | null;
  position: number;
  /** colorwayId → position, manual collections only */
  manual: Map<string, number>;
}

export interface CatalogSnapshot {
  items: IndexedItem[];
  byColorway: Map<string, IndexedItem>;
  byProduct: Map<string, IndexedItem[]>;
  categories: IndexedCategory[];
  collections: IndexedCollection[];
  loadedAt: number;
}

const TTL_MS = 30_000;

function stockState(status: string, onHand: number, reserved: number, lowThreshold: number): StockState {
  const available = onHand - reserved;
  if (status !== 'active' || available <= 0) return 'unavailable';
  return available <= lowThreshold ? 'low' : 'available';
}

const toImage = (img: { url: string; thumbUrl: string | null; alt: string; title: string | null } | undefined): ImageDto | null =>
  img ? { url: img.url, thumbUrl: img.thumbUrl, alt: img.alt, title: img.title } : null;

/**
 * Read-optimised, in-memory view of the purchasable catalog for listing, facets and sorting.
 * Refreshed on a short TTL and invalidated explicitly after catalog/stock changes. Listing stock
 * may be up to TTL stale by design — PDP, bag and checkout always read live stock.
 */
export class CatalogIndex {
  private snapshot: CatalogSnapshot | null = null;
  private loading: Promise<CatalogSnapshot> | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  invalidate(): void {
    this.snapshot = null;
  }

  async get(): Promise<CatalogSnapshot> {
    if (this.snapshot && Date.now() - this.snapshot.loadedAt < TTL_MS) return this.snapshot;
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    this.snapshot = await this.loading;
    return this.snapshot;
  }

  private async load(): Promise<CatalogSnapshot> {
    const rows = await this.db
      .select({ product: products, colorway: colorways, categoryPath: categories.path })
      .from(colorways)
      .innerJoin(products, eq(products.id, colorways.productId))
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .where(and(eq(products.status, 'active'), eq(colorways.status, 'active')))
      .orderBy(asc(products.createdAt), asc(colorways.position));

    const colorwayIds = rows.map((r) => r.colorway.id);
    const [imageRows, skuRows] = colorwayIds.length
      ? await Promise.all([
          this.db.select().from(colorwayImages).where(inArray(colorwayImages.colorwayId, colorwayIds)).orderBy(asc(colorwayImages.position)),
          this.db.select().from(skus).where(inArray(skus.colorwayId, colorwayIds)).orderBy(asc(skus.sizeSort)),
        ])
      : [[], []];

    const imagesBy = Map.groupBy(imageRows, (i) => i.colorwayId);
    const skusBy = Map.groupBy(skuRows, (s) => s.colorwayId);

    const items: IndexedItem[] = [];
    for (const [position, { product, colorway, categoryPath }] of rows.entries()) {
      const images = imagesBy.get(colorway.id) ?? [];
      const cwSkus = (skusBy.get(colorway.id) ?? []).filter((s) => s.status !== 'draft');
      const active = cwSkus.filter((s) => s.status === 'active');
      if (active.length === 0) continue;
      const cheapest = active.reduce((a, b) => (b.pricePaise < a.pricePaise ? b : a));
      const sizes = cwSkus.map((s) => ({
        label: s.sizeLabel,
        sort: s.sizeSort,
        state: stockState(s.status, s.onHand, s.reserved, s.lowStockThreshold),
      }));
      const hover = images.find((i) => imageRole(i.title) === 'side') ?? images[1];
      const activity = String((product.attributes as { activity?: string }).activity ?? categoryPath.split('/')[1] ?? '');
      items.push({
        colorwayId: colorway.id,
        productId: product.id,
        productSlug: product.slug,
        colorSlug: colorway.slug,
        href: `/p/${product.slug}/${colorway.slug}`,
        name: product.name,
        colorName: colorway.name,
        colorFamily: colorway.colorFamily,
        hex: colorway.hex ?? '#B8B2A7',
        image: toImage(images[0]),
        hoverImage: toImage(hover),
        pricePaise: cheapest.pricePaise,
        mrpPaise: cheapest.mrpPaise,
        onSale: cheapest.mrpPaise > cheapest.pricePaise,
        rating: product.ratingCount > 0 ? { value: Number(product.ratingAvg), count: product.ratingCount } : null,
        inStock: sizes.some((s) => s.state !== 'unavailable'),
        gender: product.gender,
        activity,
        categoryPath,
        sizes,
        launchedAt: product.launchedAt,
        soldCount: product.soldCount,
        position,
        searchDocument: colorway.searchDocument,
      });
    }

    const byColorway = new Map(items.map((i) => [i.colorwayId, i]));
    const byProduct = Map.groupBy(items, (i) => i.productId);

    const categoryRows = await this.db.select().from(categories).orderBy(asc(categories.position), asc(categories.name));
    const pathById = new Map(categoryRows.map((c) => [c.id, c.path]));
    const collectionRows = await this.db.select().from(collections).where(eq(collections.active, true)).orderBy(asc(collections.position));
    const manualRows = collectionRows.length
      ? await this.db.select().from(collectionItems).where(inArray(collectionItems.collectionId, collectionRows.map((c) => c.id)))
      : [];
    const manualBy = Map.groupBy(manualRows, (r) => r.collectionId);
    const now = this.clock.now();

    return {
      items,
      byColorway,
      byProduct,
      categories: categoryRows.map((c) => ({
        id: c.id,
        path: c.path,
        name: c.name,
        parentPath: c.parentId ? (pathById.get(c.parentId) ?? null) : null,
      })),
      collections: collectionRows
        .filter((c) => (!c.startsAt || c.startsAt <= now) && (!c.endsAt || c.endsAt > now))
        .map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          description: c.description,
          kind: c.kind,
          rules: c.rules ?? null,
          heroImageUrl: c.heroImageUrl,
          position: c.position,
          manual: new Map((manualBy.get(c.id) ?? []).map((r) => [r.colorwayId, r.position])),
        })),
      loadedAt: Date.now(),
    };
  }
}

export function inCategory(item: IndexedItem, path: string): boolean {
  return item.categoryPath === path || item.categoryPath.startsWith(`${path}/`);
}

export function inCollection(item: IndexedItem, collection: IndexedCollection, now: Date): boolean {
  if (collection.kind === 'manual') return collection.manual.has(item.colorwayId);
  const r = collection.rules ?? {};
  if (r.categoryPaths?.length && !r.categoryPaths.some((p) => inCategory(item, p))) return false;
  if (r.activities?.length && !r.activities.includes(item.activity)) return false;
  if (r.genders?.length && !r.genders.includes(item.gender)) return false;
  if (r.colorFamilies?.length && !r.colorFamilies.includes(item.colorFamily)) return false;
  if (r.maxPricePaise !== undefined && item.pricePaise > r.maxPricePaise) return false;
  if (r.onSale && !item.onSale) return false;
  if (r.launchedWithinDays !== undefined) {
    if (!item.launchedAt) return false;
    if (now.getTime() - item.launchedAt.getTime() > r.launchedWithinDays * 86_400_000) return false;
  }
  return true;
}
