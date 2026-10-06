import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';

export const catalogStatus = pgEnum('catalog_status', ['draft', 'active', 'discontinued']);

export const categories = pgTable('categories', {
  id: id(),
  parentId: uuid().references((): AnyPgColumn => categories.id),
  slug: text().notNull(),
  name: text().notNull(),
  /** Full slug path, e.g. "men/running". */
  path: text().notNull().unique(),
  position: integer().notNull().default(0),
  createdAt: createdAt(),
});

export interface SizeChartRow {
  ukInd: string;
  us: string;
  eu: string;
  cm: number;
}

export const sizeCharts = pgTable('size_charts', {
  id: id(),
  name: text().notNull().unique(),
  rows: jsonb().$type<SizeChartRow[]>().notNull(),
  guidance: text(),
});

export type ProductAttributes = Record<string, string | number | boolean | string[]>;

export const products = pgTable(
  'products',
  {
    id: id(),
    externalId: text().unique(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    shortDescription: text().notNull().default(''),
    description: text().notNull().default(''),
    highlights: text().array().notNull().default(sql`'{}'::text[]`),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    categoryId: uuid()
      .notNull()
      .references(() => categories.id),
    gender: text().$type<'men' | 'women' | 'unisex' | 'kids'>().notNull().default('unisex'),
    attributes: jsonb().$type<ProductAttributes>().notNull().default({}),
    sizeChartId: uuid().references(() => sizeCharts.id),
    /** GST rate in basis points (1800 = 18%). Prices are GST-inclusive. */
    gstRateBps: integer().notNull().default(1800),
    isFinalSale: boolean().notNull().default(false),
    status: catalogStatus().notNull().default('draft'),
    ratingAvg: numeric({ precision: 3, scale: 2 }).notNull().default('0'),
    ratingCount: integer().notNull().default(0),
    fitSmallCount: integer().notNull().default(0),
    fitTrueCount: integer().notNull().default(0),
    fitLargeCount: integer().notNull().default(0),
    soldCount: integer().notNull().default(0),
    launchedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('products_category_idx').on(t.categoryId),
    index('products_status_idx').on(t.status),
  ],
);

export const colorways = pgTable(
  'colorways',
  {
    id: id(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    externalId: text().unique(),
    slug: text().notNull(),
    name: text().notNull(),
    colorFamily: text().notNull(),
    hex: text(),
    status: catalogStatus().notNull().default('draft'),
    position: integer().notNull().default(0),
    /** Lower-cased text used for search (product + colour + category + tags). Maintained by the importer. */
    searchDocument: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('colorways_product_slug_uq').on(t.productId, t.slug),
    index('colorways_search_trgm_idx').using('gin', sql`${t.searchDocument} gin_trgm_ops`),
  ],
);

export const colorwayImages = pgTable(
  'colorway_images',
  {
    id: id(),
    colorwayId: uuid()
      .notNull()
      .references(() => colorways.id, { onDelete: 'cascade' }),
    externalId: text(),
    url: text().notNull(),
    thumbUrl: text(),
    title: text(),
    alt: text().notNull().default(''),
    position: integer().notNull().default(0),
    width: integer(),
    height: integer(),
  },
  (t) => [index('colorway_images_colorway_idx').on(t.colorwayId, t.position)],
);

export const skus = pgTable(
  'skus',
  {
    id: id(),
    colorwayId: uuid()
      .notNull()
      .references(() => colorways.id, { onDelete: 'cascade' }),
    skuCode: text().notNull().unique(),
    sizeLabel: text().notNull(),
    sizeSort: integer().notNull(),
    pricePaise: integer().notNull(),
    mrpPaise: integer().notNull(),
    status: catalogStatus().notNull().default('draft'),
    onHand: integer().notNull().default(0),
    reserved: integer().notNull().default(0),
    lowStockThreshold: integer().notNull().default(5),
    maxPerOrder: integer().notNull().default(5),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('skus_colorway_idx').on(t.colorwayId),
    uniqueIndex('skus_colorway_size_uq').on(t.colorwayId, t.sizeLabel),
    check('skus_on_hand_nonneg', sql`${t.onHand} >= 0`),
    check('skus_reserved_nonneg', sql`${t.reserved} >= 0`),
    check('skus_reserved_lte_on_hand', sql`${t.reserved} <= ${t.onHand}`),
    check('skus_price_positive', sql`${t.pricePaise} > 0`),
    check('skus_price_lte_mrp', sql`${t.pricePaise} <= ${t.mrpPaise}`),
    check('skus_max_per_order_positive', sql`${t.maxPerOrder} > 0`),
  ],
);

export const priceHistory = pgTable(
  'price_history',
  {
    id: id(),
    skuId: uuid()
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    oldPricePaise: integer().notNull(),
    newPricePaise: integer().notNull(),
    changedAt: createdAt(),
  },
  (t) => [index('price_history_sku_idx').on(t.skuId, t.changedAt)],
);

export const collectionKind = pgEnum('collection_kind', ['manual', 'rule']);

export interface CollectionRules {
  categoryPaths?: string[];
  activities?: string[];
  genders?: string[];
  colorFamilies?: string[];
  maxPricePaise?: number;
  onSale?: boolean;
  launchedWithinDays?: number;
}

export const collections = pgTable('collections', {
  id: id(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  description: text().notNull().default(''),
  kind: collectionKind().notNull().default('manual'),
  rules: jsonb().$type<CollectionRules>(),
  heroImageUrl: text(),
  position: integer().notNull().default(0),
  active: boolean().notNull().default(true),
  startsAt: ts(),
  endsAt: ts(),
  createdAt: createdAt(),
});

export const collectionItems = pgTable(
  'collection_items',
  {
    collectionId: uuid()
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    colorwayId: uuid()
      .notNull()
      .references(() => colorways.id, { onDelete: 'cascade' }),
    position: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.colorwayId] })],
);
