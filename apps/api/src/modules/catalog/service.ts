import {
  SUGGESTED_QUERIES,
  colorFamilyLabel,
  isEmptyInterpretation,
  parseSearchQuery,
  type CategoryNodeDto,
  type CollectionDto,
  type ColorwayDto,
  type FacetValue,
  type HomeDto,
  type ListingContext,
  type ListingItemDto,
  type ListingQuery,
  type ListingResponse,
  type Relaxation,
  type ProductDetailDto,
  type SearchInterpretation,
  type SortOption,
  type SuggestResponse,
} from '@avero/shared';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import { categories, colorwayImages, colorways, products, searchQueries, sizeCharts, skus } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { inCategory, inCollection, type CatalogSnapshot, type IndexedItem } from './catalog-index';
import { ACTIVITY_LABELS, GENDER_LABELS } from './importer/normalize';
import { pickImage, type ImageRole } from './images';
import { HOME_CONTENT } from './importer/merchandising';

type CatalogDeps = AppContext;

const NEW_BADGE_DAYS = 30;
const BESTSELLER_COLLECTION = 'best-sellers';

const label = (map: Record<string, string>, v: string) => map[v] ?? v.charAt(0).toUpperCase() + v.slice(1);

/** Typo-tolerant free-text match in Postgres (pg_trgm). Every token must match. */
async function textSearch(deps: CatalogDeps, text: string): Promise<Map<string, number>> {
  const tokens = text.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
  if (tokens.length === 0) return new Map();
  const conditions = tokens.map(
    (t) => sql`(word_similarity(${t}, ${colorways.searchDocument}) >= 0.4 OR ${colorways.searchDocument} ILIKE ${`%${t}%`})`,
  );
  const score = sql.join(
    tokens.map((t) => sql`word_similarity(${t}, ${colorways.searchDocument})`),
    sql` + `,
  );
  const rows = await deps.db
    .select({ id: colorways.id, score: sql<number>`${score}` })
    .from(colorways)
    .where(sql.join(conditions, sql` AND `));
  return new Map(rows.map((r) => [r.id, Number(r.score)]));
}

interface Filters {
  gender: string[];
  activity: string[];
  color: string[];
  size: string[];
  priceMin?: number;
  priceMax?: number;
  ratingMin?: number;
  onSale: boolean;
  inStock: boolean;
}

type Dimension = 'gender' | 'activity' | 'color' | 'size' | 'price' | 'rating' | 'onSale' | 'inStock';

function matches(item: IndexedItem, f: Filters, skip?: Dimension): boolean {
  if (skip !== 'gender' && f.gender.length && !f.gender.includes(item.gender)) return false;
  if (skip !== 'activity' && f.activity.length && !f.activity.includes(item.activity)) return false;
  if (skip !== 'color' && f.color.length && !f.color.includes(item.colorFamily)) return false;
  if (skip !== 'size' && f.size.length && !item.sizes.some((s) => f.size.includes(s.label) && s.state !== 'unavailable')) return false;
  if (skip !== 'price') {
    const rupees = item.pricePaise / 100;
    if (f.priceMin !== undefined && rupees < f.priceMin) return false;
    if (f.priceMax !== undefined && rupees > f.priceMax) return false;
  }
  if (skip !== 'rating' && f.ratingMin !== undefined && (item.rating?.value ?? 0) < f.ratingMin) return false;
  if (skip !== 'onSale' && f.onSale && !item.onSale) return false;
  if (skip !== 'inStock' && f.inStock && !item.inStock) return false;
  return true;
}

function countBy(items: IndexedItem[], key: (i: IndexedItem) => string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) for (const k of new Set(key(item))) counts.set(k, (counts.get(k) ?? 0) + 1);
  return counts;
}

function badgeFor(item: IndexedItem, snap: CatalogSnapshot, now: Date): ListingItemDto['badge'] {
  const best = snap.collections.find((c) => c.slug === BESTSELLER_COLLECTION);
  if (best && inCollection(item, best, now)) return 'Bestseller';
  if (item.launchedAt && now.getTime() - item.launchedAt.getTime() < NEW_BADGE_DAYS * 86_400_000) return 'New';
  return null;
}

export function toListingDto(item: IndexedItem, snap: CatalogSnapshot, now: Date): ListingItemDto {
  const siblings = snap.byProduct.get(item.productId) ?? [item];
  return {
    colorwayId: item.colorwayId,
    productId: item.productId,
    href: item.href,
    name: item.name,
    colorName: item.colorName,
    colorFamily: item.colorFamily,
    hex: item.hex,
    image: item.image,
    hoverImage: item.hoverImage,
    pricePaise: item.pricePaise,
    mrpPaise: item.mrpPaise,
    badge: badgeFor(item, snap, now),
    swatches: siblings.map((s) => ({ colorwayId: s.colorwayId, name: s.colorName, hex: s.hex, href: s.href })),
    rating: item.rating,
    inStock: item.inStock,
    gender: item.gender,
    activity: item.activity,
  };
}

function categoryTitle(path: string, name: string): string {
  const [gender, activity] = path.split('/');
  const g = gender && (GENDER_LABELS as Record<string, string>)[gender];
  if (!g) return name;
  return activity ? `${g}'s ${name}` : `${g}'s Shoes`;
}

function sortItems(items: IndexedItem[], sort: SortOption, ctx: { scores?: Map<string, number>; manual?: Map<string, number>; bestsellers: Set<string> }) {
  const byPosition = (a: IndexedItem, b: IndexedItem) => {
    const ma = ctx.manual?.get(a.colorwayId);
    const mb = ctx.manual?.get(b.colorwayId);
    if (ma !== undefined || mb !== undefined) return (ma ?? Infinity) - (mb ?? Infinity);
    const ba = ctx.bestsellers.has(a.colorwayId) ? 0 : 1;
    const bb = ctx.bestsellers.has(b.colorwayId) ? 0 : 1;
    return ba - bb || Number(b.inStock) - Number(a.inStock) || a.position - b.position;
  };
  const time = (d: Date | null) => d?.getTime() ?? 0;
  const compare: Record<SortOption, (a: IndexedItem, b: IndexedItem) => number> = {
    featured: byPosition,
    relevance: (a, b) => (ctx.scores?.get(b.colorwayId) ?? 0) - (ctx.scores?.get(a.colorwayId) ?? 0) || byPosition(a, b),
    newest: (a, b) => time(b.launchedAt) - time(a.launchedAt) || a.position - b.position,
    price_asc: (a, b) => a.pricePaise - b.pricePaise || a.position - b.position,
    price_desc: (a, b) => b.pricePaise - a.pricePaise || a.position - b.position,
    bestselling: (a, b) => b.soldCount - a.soldCount || byPosition(a, b),
    top_rated: (a, b) => (b.rating?.value ?? 0) - (a.rating?.value ?? 0) || (b.rating?.count ?? 0) - (a.rating?.count ?? 0) || byPosition(a, b),
  };
  return [...items].sort(compare[sort]);
}

export async function listProducts(deps: CatalogDeps, query: ListingQuery): Promise<ListingResponse> {
  const snap = await deps.catalog.get();
  const now = deps.clock.now();
  let scope = snap.items;
  let context: ListingContext = { title: 'All shoes', description: null, heroImageUrl: null, breadcrumbs: [{ label: 'Home', to: '/' }, { label: 'All shoes' }] };
  let manual: Map<string, number> | undefined;

  if (query.category) {
    const cat = snap.categories.find((c) => c.path === query.category);
    if (!cat) throw new AppError('NOT_FOUND', 'Category not found');
    scope = scope.filter((i) => inCategory(i, cat.path));
    const parent = cat.parentPath ? snap.categories.find((c) => c.path === cat.parentPath) : undefined;
    context = {
      title: categoryTitle(cat.path, cat.name),
      description: null,
      heroImageUrl: null,
      breadcrumbs: [
        { label: 'Home', to: '/' },
        ...(parent ? [{ label: parent.name, to: `/c/${parent.path}` }] : []),
        { label: cat.name },
      ],
    };
  }
  if (query.collection) {
    const col = snap.collections.find((c) => c.slug === query.collection);
    if (!col) throw new AppError('NOT_FOUND', 'Collection not found');
    scope = scope.filter((i) => inCollection(i, col, now));
    if (col.kind === 'manual') manual = col.manual;
    context = {
      title: col.name,
      description: col.description || null,
      heroImageUrl: col.heroImageUrl,
      breadcrumbs: [{ label: 'Home', to: '/' }, { label: 'Collections', to: '/collections' }, { label: col.name }],
    };
  }

  let interpretation: SearchInterpretation | null = null;
  let scores: Map<string, number> | undefined;
  if (query.q) {
    interpretation = parseSearchQuery(query.q);
    if (interpretation.text) {
      scores = await textSearch(deps, interpretation.text);
      scope = scope.filter((i) => scores!.has(i.colorwayId));
    }
    context = {
      title: `Results for “${query.q}”`,
      description: null,
      heroImageUrl: null,
      breadcrumbs: [{ label: 'Home', to: '/' }, { label: 'Search' }],
    };
  }

  // Explicit filters win over ones inferred from the query.
  const i = interpretation;
  const filters: Filters = {
    gender: query.gender.length ? query.gender : (i?.gender ?? []),
    activity: query.activity.length ? query.activity : (i?.activity ?? []),
    color: query.color.length ? query.color : (i?.color ?? []),
    size: query.size.length ? query.size : (i?.size ?? []),
    priceMin: query.priceMin ?? i?.priceMin,
    priceMax: query.priceMax ?? i?.priceMax,
    ratingMin: query.ratingMin,
    onSale: query.onSale,
    inStock: query.inStock,
  };

  const results = scope.filter((it) => matches(it, filters));
  const facetSet = (d: Dimension) => scope.filter((it) => matches(it, filters, d));

  const genderCounts = countBy(facetSet('gender'), (it) => [it.gender]);
  const activityCounts = countBy(facetSet('activity'), (it) => [it.activity]);
  const colorItems = facetSet('color');
  const colorCounts = countBy(colorItems, (it) => [it.colorFamily]);
  const sizeItems = facetSet('size');
  const sizeCounts = countBy(sizeItems, (it) => it.sizes.filter((s) => s.state !== 'unavailable').map((s) => s.label));
  const sizeOrder = new Map(snap.items.flatMap((it) => it.sizes.map((s) => [s.label, s.sort] as const)));
  const priceItems = facetSet('price');

  const facet = (counts: Map<string, number>, labels: Record<string, string>, selected: string[]): FacetValue[] => {
    const values = new Set([...counts.keys(), ...selected]);
    return [...values]
      .map((v) => ({ value: v, label: label(labels, v), count: counts.get(v) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };

  const sort: SortOption = query.sort ?? (query.q && interpretation?.text ? 'relevance' : 'featured');
  const best = snap.collections.find((c) => c.slug === BESTSELLER_COLLECTION);
  const bestsellers = new Set(best ? snap.items.filter((it) => inCollection(it, best, now)).map((it) => it.colorwayId) : []);
  const sorted = sortItems(results, sort, { scores, manual, bestsellers });

  return {
    items: sorted.slice(query.offset, query.offset + query.limit).map((it) => toListingDto(it, snap, now)),
    relaxations: sorted.length === 0 ? relaxations(scope, filters, interpretation) : [],
    total: sorted.length,
    offset: query.offset,
    limit: query.limit,
    sort,
    facets: {
      gender: facet(genderCounts, GENDER_LABELS, filters.gender),
      activity: facet(activityCounts, ACTIVITY_LABELS, filters.activity),
      color: [...new Set([...colorCounts.keys(), ...filters.color])]
        .map((v) => ({
          value: v,
          label: colorFamilyLabel(v),
          count: colorCounts.get(v) ?? 0,
          hex: colorItems.find((it) => it.colorFamily === v)?.hex,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      size: [...new Set([...sizeCounts.keys(), ...filters.size])]
        .map((v) => ({ value: v, label: v, count: sizeCounts.get(v) ?? 0 }))
        .sort((a, b) => (sizeOrder.get(a.value) ?? 0) - (sizeOrder.get(b.value) ?? 0)),
      price: priceItems.length
        ? {
            min: Math.floor(Math.min(...priceItems.map((it) => it.pricePaise)) / 100),
            max: Math.ceil(Math.max(...priceItems.map((it) => it.pricePaise)) / 100),
          }
        : null,
      onSale: facetSet('onSale').filter((it) => it.onSale).length,
      inStock: facetSet('inStock').filter((it) => it.inStock).length,
    },
    context,
    interpretation: interpretation && !isEmptyInterpretation(interpretation) ? interpretation : null,
  };
}

/** For empty results: what dropping each constraint would yield (most useful first). */
function relaxations(scope: IndexedItem[], f: Filters, interp: SearchInterpretation | null): Relaxation[] {
  const out: Relaxation[] = [];
  const describe = (g: Filters) =>
    [
      g.color.map(colorFamilyLabel).join('/'),
      g.gender.map((v) => `${label(GENDER_LABELS, v)}'s`).join('/'),
      g.activity.map((v) => label(ACTIVITY_LABELS, v).toLowerCase()).join('/') || 'shoes',
      g.size.length ? `in size ${g.size.join('/')}` : '',
      g.priceMax !== undefined ? `under ₹${g.priceMax.toLocaleString('en-IN')}` : '',
      g.priceMin !== undefined ? `over ₹${g.priceMin.toLocaleString('en-IN')}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  // A relaxed search is expressed as explicit filters + q cleared, so the UI can just navigate.
  const asParams = (g: Filters): Record<string, string> => ({
    q: interp?.text ?? '',
    gender: g.gender.join(','),
    activity: g.activity.join(','),
    color: g.color.join(','),
    size: g.size.join(','),
    priceMin: g.priceMin?.toString() ?? '',
    priceMax: g.priceMax?.toString() ?? '',
    onSale: g.onSale ? 'true' : '',
    inStock: g.inStock ? 'true' : '',
  });
  const variants: [active: boolean, relaxed: Filters][] = [
    [f.color.length > 0, { ...f, color: [] }],
    [f.size.length > 0, { ...f, size: [] }],
    [f.priceMin !== undefined || f.priceMax !== undefined, { ...f, priceMin: undefined, priceMax: undefined }],
    [f.gender.length > 0, { ...f, gender: [] }],
    [f.activity.length > 0, { ...f, activity: [] }],
    [f.onSale || f.inStock, { ...f, onSale: false, inStock: false }],
  ];
  for (const [active, g] of variants) {
    if (!active) continue;
    const count = scope.filter((it) => matches(it, g)).length;
    const text = describe(g);
    if (count > 0) out.push({ label: text.charAt(0).toUpperCase() + text.slice(1), params: asParams(g), count });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 3);
}

export async function recordSearch(deps: CatalogDeps, query: string, resultCount: number): Promise<void> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return;
  await deps.db.insert(searchQueries).values({ query: q.slice(0, 100), resultCount });
}

export async function trendingSearches(deps: CatalogDeps): Promise<string[]> {
  const since = new Date(deps.clock.now().getTime() - 7 * 86_400_000);
  const rows = await deps.db
    .select({ query: searchQueries.query, n: sql<number>`count(*)` })
    .from(searchQueries)
    .where(and(gt(searchQueries.createdAt, since), gt(searchQueries.resultCount, 0)))
    .groupBy(searchQueries.query)
    .orderBy(desc(sql`count(*)`))
    .limit(6);
  const popular = rows.filter((r) => Number(r.n) >= 2).map((r) => r.query);
  return [...new Set([...popular, ...SUGGESTED_QUERIES])].slice(0, 6);
}

export async function suggest(deps: CatalogDeps, q: string): Promise<SuggestResponse> {
  const query = q.trim().toLowerCase();
  const snap = await deps.catalog.get();
  const result = await listProducts(deps, {
    q: query,
    size: [],
    color: [],
    gender: [],
    activity: [],
    onSale: false,
    inStock: false,
    offset: 0,
    limit: 5,
  });

  const words = query.split(/\s+/).filter(Boolean);
  const matchesWords = (text: string) => words.every((w) => text.toLowerCase().includes(w.replace(/'s$/, '')));
  const categorySuggestions = snap.categories
    .filter((c) => c.parentPath && snap.items.some((it) => inCategory(it, c.path)))
    .map((c) => ({ label: categoryTitle(c.path, c.name), to: `/c/${c.path}` }))
    .filter((c) => words.length > 0 && words.some((w) => c.label.toLowerCase().includes(w.replace(/'s$/, ''))))
    .slice(0, 4);
  const collectionSuggestions = snap.collections
    .filter((c) => matchesWords(`${c.name} ${c.description}`) || words.some((w) => c.name.toLowerCase().startsWith(w)))
    .map((c) => ({ label: c.name, to: `/collections/${c.slug}` }))
    .slice(0, 3);
  const trending = await trendingSearches(deps);
  const queries = [...new Set([...trending, ...SUGGESTED_QUERIES])]
    .filter((s) => s !== query && words.every((w) => s.includes(w)))
    .slice(0, 4);

  return {
    query: q,
    products: result.items.map((it) => ({ href: it.href, name: it.name, colorName: it.colorName, pricePaise: it.pricePaise, image: it.image })),
    categories: categorySuggestions,
    collections: collectionSuggestions,
    queries,
  };
}

export async function getProductDetail(deps: CatalogDeps, slug: string): Promise<ProductDetailDto> {
  const product = await deps.db.query.products.findFirst({ where: eq(products.slug, slug) });
  if (!product || product.status === 'draft') throw new AppError('NOT_FOUND', 'Product not found');

  const category = await deps.db.query.categories.findFirst({ where: eq(categories.id, product.categoryId) });
  const parent = category?.parentId ? await deps.db.query.categories.findFirst({ where: eq(categories.id, category.parentId) }) : undefined;
  const cws = await deps.db.query.colorways.findMany({
    where: and(eq(colorways.productId, product.id), inArray(colorways.status, ['active', 'discontinued'])),
    orderBy: asc(colorways.position),
  });
  if (cws.length === 0) throw new AppError('NOT_FOUND', 'Product not found');
  const ids = cws.map((c) => c.id);
  const [imageRows, skuRows] = await Promise.all([
    deps.db.select().from(colorwayImages).where(inArray(colorwayImages.colorwayId, ids)).orderBy(asc(colorwayImages.position)),
    deps.db.select().from(skus).where(inArray(skus.colorwayId, ids)).orderBy(asc(skus.sizeSort)),
  ]);
  const chart = product.sizeChartId ? await deps.db.query.sizeCharts.findFirst({ where: eq(sizeCharts.id, product.sizeChartId) }) : undefined;

  const productActive = product.status === 'active';
  const colorwayDtos: ColorwayDto[] = cws.map((c) => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    colorFamily: c.colorFamily,
    hex: c.hex ?? '#B8B2A7',
    href: `/p/${product.slug}/${c.slug}`,
    purchasable: productActive && c.status === 'active',
    images: imageRows.filter((i) => i.colorwayId === c.id).map((i) => ({ url: i.url, thumbUrl: i.thumbUrl, mediumUrl: i.mediumUrl, alt: i.alt, title: i.title })),
    skus: skuRows
      .filter((s) => s.colorwayId === c.id && s.status !== 'draft')
      .map((s) => {
        const available = s.onHand - s.reserved;
        const purchasable = productActive && c.status === 'active' && s.status === 'active';
        const state = !purchasable || available <= 0 ? 'unavailable' : available <= s.lowStockThreshold ? 'low' : 'available';
        return {
          id: s.id,
          sizeLabel: s.sizeLabel,
          pricePaise: s.pricePaise,
          mrpPaise: s.mrpPaise,
          state,
          left: state === 'low' && available <= business.lowStockDisplay ? available : null,
          maxPerOrder: s.maxPerOrder,
        };
      }),
  }));

  const snap = await deps.catalog.get();
  const firstIndexed = snap.byProduct.get(product.id)?.[0];
  const activity = String((product.attributes as { activity?: string }).activity ?? '');

  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    shortDescription: product.shortDescription,
    description: product.description,
    highlights: product.highlights,
    gender: product.gender,
    activity,
    category: {
      path: category?.path ?? '',
      name: category ? categoryTitle(category.path, category.name) : '',
      parent: parent ? { path: parent.path, name: categoryTitle(parent.path, parent.name) } : null,
    },
    status: product.status,
    isFinalSale: product.isFinalSale,
    gstRateBps: product.gstRateBps,
    rating: {
      value: Number(product.ratingAvg),
      count: product.ratingCount,
      fit: { small: product.fitSmallCount, true: product.fitTrueCount, large: product.fitLargeCount },
    },
    sizeChart: chart ? { name: chart.name, guidance: chart.guidance, rows: chart.rows } : null,
    colorways: colorwayDtos,
    badge: firstIndexed ? badgeFor(firstIndexed, snap, deps.clock.now()) : null,
  };
}

/** "You may also like": same gender and activity first, then shared tags/colour, then price proximity. */
export async function recommendations(deps: CatalogDeps, productSlug: string, limit = 8): Promise<ListingItemDto[]> {
  const snap = await deps.catalog.get();
  const now = deps.clock.now();
  const self = snap.items.find((i) => i.productSlug === productSlug);
  if (!self) return [];
  const selfTags = new Set(self.searchDocument.split(' '));
  const seen = new Set<string>();
  return snap.items
    .filter((i) => i.productId !== self.productId)
    .map((i) => {
      const overlap = i.searchDocument.split(' ').filter((w) => w.length > 3 && selfTags.has(w)).length;
      const score =
        (i.gender === self.gender ? 4 : i.gender === 'unisex' ? 2 : 0) +
        (i.activity === self.activity ? 3 : 0) +
        (i.colorFamily === self.colorFamily ? 1 : 0) +
        Math.min(overlap, 5) * 0.4 -
        Math.abs(i.pricePaise - self.pricePaise) / self.pricePaise +
        (i.inStock ? 1 : -3);
      return { i, score };
    })
    .sort((a, b) => b.score - a.score)
    .filter(({ i }) => (seen.has(i.productId) ? false : (seen.add(i.productId), true)))
    .slice(0, limit)
    .map(({ i }) => toListingDto(i, snap, now));
}

export async function listCollections(deps: CatalogDeps): Promise<CollectionDto[]> {
  const snap = await deps.catalog.get();
  const now = deps.clock.now();
  return snap.collections.map((c) => {
    const members = snap.items.filter((i) => inCollection(i, c, now));
    const cover = c.kind === 'manual' ? [...members].sort((a, b) => (c.manual.get(a.colorwayId) ?? 0) - (c.manual.get(b.colorwayId) ?? 0))[0] : members[0];
    return {
      slug: c.slug,
      name: c.name,
      description: c.description,
      heroImageUrl: c.heroImageUrl,
      coverImage: cover?.image ?? null,
      productCount: members.length,
    };
  });
}

export async function categoryTree(deps: CatalogDeps): Promise<CategoryNodeDto[]> {
  const snap = await deps.catalog.get();
  const build = (parentPath: string | null): CategoryNodeDto[] =>
    snap.categories
      .filter((c) => c.parentPath === parentPath)
      .map((c) => {
        const members = snap.items.filter((i) => inCategory(i, c.path));
        return {
          path: c.path,
          name: c.parentPath ? c.name : `${c.name}`,
          coverImage: members[0]?.image ?? null,
          productCount: members.length,
          children: build(c.path),
        };
      })
      .filter((c) => c.productCount > 0);
  return build(null);
}

async function imageByRole(deps: CatalogDeps, from: { product: string; role: ImageRole; nth: number }) {
  const snap = await deps.catalog.get();
  const item = snap.items.find((i) => i.productSlug === from.product);
  if (!item) return null;
  const images = await deps.db.query.colorwayImages.findMany({
    where: eq(colorwayImages.colorwayId, item.colorwayId),
    orderBy: asc(colorwayImages.position),
  });
  const img = pickImage(images, from.role, from.nth);
  return img ? { url: img.url, thumbUrl: img.thumbUrl, mediumUrl: img.mediumUrl, alt: img.alt, title: img.title } : item.image;
}

export async function homeContent(deps: CatalogDeps): Promise<HomeDto> {
  const snap = await deps.catalog.get();
  const now = deps.clock.now();
  const collectionMembers = (slug: string) => {
    const c = snap.collections.find((x) => x.slug === slug);
    return c ? snap.items.filter((i) => inCollection(i, c, now)) : [];
  };

  const hero = HOME_CONTENT.hero.flatMap((h) => {
    const c = snap.collections.find((x) => x.slug === h.collection);
    if (!c) return [];
    const image = c.heroImageUrl ? { url: c.heroImageUrl, thumbUrl: null, mediumUrl: null, alt: `${c.name} — AVERO` } : (collectionMembers(c.slug)[0]?.image ?? null);
    return [{ eyebrow: h.eyebrow, title: h.title, body: h.body, image, to: `/collections/${c.slug}` }];
  });

  const tiles = HOME_CONTENT.tiles.map((t) => {
    const from: { collection?: string; category?: string; pick?: number } = t.from;
    const members = from.collection
      ? collectionMembers(from.collection)
      : snap.items.filter((i) => inCategory(i, from.category ?? ''));
    const pick = members[(from.pick ?? 0) % Math.max(members.length, 1)];
    return { title: t.title, to: t.to, tone: t.tone, image: pick?.image ?? null, arch: 'arch' in t ? t.arch : false };
  });

  const e = HOME_CONTENT.editorial;
  const editorial = {
    eyebrow: e.eyebrow,
    title: e.title,
    body: e.body,
    to: e.to,
    cta: e.cta,
    image: await imageByRole(deps, e.imageFrom),
    secondaryImage: await imageByRole(deps, e.secondaryFrom),
  };

  const list = (filter: (i: IndexedItem) => boolean) =>
    snap.items.filter(filter).slice(0, 8).map((i) => toListingDto(i, snap, now));
  const best = new Set(collectionMembers('best-sellers').map((i) => i.colorwayId));
  return {
    hero,
    tiles,
    editorial,
    showcase: {
      featured: [...snap.items]
        .sort((a, b) => Number(best.has(b.colorwayId)) - Number(best.has(a.colorwayId)) || a.position - b.position)
        .slice(0, 8)
        .map((i) => toListingDto(i, snap, now)),
      men: list((i) => i.gender === 'men'),
      women: list((i) => i.gender === 'women'),
    },
  };
}
