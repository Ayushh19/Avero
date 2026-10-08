import { z } from 'zod';
import { SORT_OPTIONS, type SortOption } from '../catalog/sort';

export { SORT_LABELS, SORT_OPTIONS, type SortOption } from '../catalog/sort';

const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) =>
    (Array.isArray(v) ? v : (v ?? '').split(','))
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

const flag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

/** PLP / search query. Prices are in whole rupees (what shoppers type), not paise. */
export const listingQuerySchema = z.object({
  category: z.string().trim().max(120).optional(),
  collection: z.string().trim().max(120).optional(),
  q: z.string().trim().max(100).optional(),
  /** What the shopper typed (display only). */
  qraw: z.string().trim().max(100).optional(),
  size: csv,
  color: csv,
  gender: csv,
  activity: csv,
  priceMin: z.coerce.number().int().nonnegative().optional(),
  priceMax: z.coerce.number().int().positive().optional(),
  ratingMin: z.coerce.number().min(1).max(5).optional(),
  onSale: flag,
  inStock: flag,
  sort: z.enum(SORT_OPTIONS).optional(),
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});
export type ListingQueryInput = z.input<typeof listingQuerySchema>;
export type ListingQuery = z.output<typeof listingQuerySchema>;

export interface ImageDto {
  /** Original (1024px). */
  url: string;
  /** 400px. */
  thumbUrl: string | null;
  /** 640px; null until the variant has been made. */
  mediumUrl: string | null;
  alt: string;
  title?: string | null;
}

export interface SwatchDto {
  colorwayId: string;
  name: string;
  hex: string;
  href: string;
}

export interface ListingItemDto {
  colorwayId: string;
  productId: string;
  href: string;
  name: string;
  colorName: string;
  colorFamily: string;
  hex: string;
  image: ImageDto | null;
  hoverImage: ImageDto | null;
  pricePaise: number;
  mrpPaise: number;
  badge: 'New' | 'Bestseller' | null;
  swatches: SwatchDto[];
  rating: { value: number; count: number } | null;
  inStock: boolean;
  gender: string;
  activity: string;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
  hex?: string;
}

export interface ListingFacets {
  gender: FacetValue[];
  activity: FacetValue[];
  size: FacetValue[];
  color: FacetValue[];
  price: { min: number; max: number } | null;
  onSale: number;
  inStock: number;
}

/** How a free-text query was understood, so the UI can show and undo it. */
export interface SearchInterpretation {
  query: string;
  text: string;
  gender: string[];
  activity: string[];
  color: string[];
  size: string[];
  priceMin?: number;
  priceMax?: number;
}

export interface ListingContext {
  title: string;
  description: string | null;
  heroImageUrl: string | null;
  breadcrumbs: { label: string; to?: string }[];
}

/** A way to broaden a search that returned nothing, with how many results it would give. */
export interface Relaxation {
  label: string;
  /** Query-string parameters to apply (empty string = remove the parameter). */
  params: Record<string, string>;
  count: number;
}

export interface ListingResponse {
  items: ListingItemDto[];
  relaxations: Relaxation[];
  total: number;
  offset: number;
  limit: number;
  sort: SortOption;
  facets: ListingFacets;
  context: ListingContext;
  interpretation: SearchInterpretation | null;
}

export type StockState = 'available' | 'low' | 'unavailable';

export interface SkuDto {
  id: string;
  sizeLabel: string;
  pricePaise: number;
  mrpPaise: number;
  state: StockState;
  /** Exact units left, only disclosed when low. */
  left: number | null;
  maxPerOrder: number;
}

export interface ColorwayDto {
  id: string;
  slug: string;
  name: string;
  colorFamily: string;
  hex: string;
  href: string;
  purchasable: boolean;
  images: ImageDto[];
  skus: SkuDto[];
}

export interface SizeChartDto {
  name: string;
  guidance: string | null;
  rows: { ukInd: string; us: string; eu: string; cm: number }[];
}

export interface ProductDetailDto {
  id: string;
  slug: string;
  name: string;
  shortDescription: string;
  description: string;
  highlights: string[];
  gender: string;
  activity: string;
  category: { path: string; name: string; parent: { path: string; name: string } | null };
  status: 'active' | 'discontinued' | 'draft';
  isFinalSale: boolean;
  gstRateBps: number;
  rating: { value: number; count: number; fit: { small: number; true: number; large: number } };
  sizeChart: SizeChartDto | null;
  colorways: ColorwayDto[];
  badge: 'New' | 'Bestseller' | null;
}

export interface SuggestResponse {
  query: string;
  products: { href: string; name: string; colorName: string; pricePaise: number; image: ImageDto | null }[];
  categories: { label: string; to: string }[];
  collections: { label: string; to: string }[];
  queries: string[];
}

export interface CollectionDto {
  slug: string;
  name: string;
  description: string;
  heroImageUrl: string | null;
  coverImage: ImageDto | null;
  productCount: number;
}

export interface CategoryNodeDto {
  path: string;
  name: string;
  coverImage: ImageDto | null;
  productCount: number;
  children: CategoryNodeDto[];
}

export interface HomeDto {
  hero: { eyebrow: string; title: string; body: string; image: ImageDto | null; to: string }[];
  tiles: { title: string; to: string; tone: 'mist' | 'sage' | 'sand' | 'mauve'; image: ImageDto | null; arch: boolean }[];
  /** Editorial slides, shown as an auto-rotating carousel. */
  editorial: { eyebrow: string; title: string; body: string; to: string; cta: string; image: ImageDto | null; secondaryImage: ImageDto | null }[];
  showcase: { featured: ListingItemDto[]; men: ListingItemDto[]; women: ListingItemDto[] };
}

export interface DeliveryEstimateDto {
  pincode: string;
  serviceable: boolean;
  city: string | null;
  state: string | null;
  options: { method: 'standard' | 'express'; label: string; feePaise: number; freeAbovePaise: number; earliest: string; latest: string }[];
  message: string;
}
