import { enqueuePriceDropCheck } from '../../alerts/price-drops';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { Db, Tx } from '../../../db/client';
import {
  categories,
  collectionItems,
  collections,
  colorwayImages,
  colorways,
  inventoryMovements,
  products,
  sizeCharts,
  skus,
} from '../../../db/schema';
import type { SimulatedClock } from '../../../lib/clock';
import { mediumUrlFor, thumbUrlFor, writeImageVariants } from '../../../lib/media';
import { percentOf } from '@avero/shared';
import { pickImage } from '../images';
import { ensureSizeCharts } from '../size-charts';
import { COLLECTIONS, LAUNCH_MRP_MARKUP_BPS } from './merchandising';
import {
  ACTIVITY_LABELS,
  GENDER_LABELS,
  buildSearchDocument,
  isImportable,
  normalizeItem,
  type NormalizedImage,
  type NormalizedProduct,
} from './normalize';
import { fetchSourcePack, type SourceItem } from './source';

export interface ImportOptions {
  sourceUrl?: string;
  /** Pre-fetched source items (tests). */
  items?: SourceItem[];
  mediaDir: string;
  dryRun?: boolean;
  reprice?: boolean;
  resetStock?: boolean;
  /** Override for tests; default downloads over HTTP. */
  download?: (url: string) => Promise<Uint8Array>;
  log?: (message: string) => void;
}

export interface ImportReport {
  dryRun: boolean;
  sourceItems: number;
  skipped: number;
  productsCreated: string[];
  productsUpdated: string[];
  skusCreated: number;
  skusDiscontinued: number;
  imagesDownloaded: number;
  missingFromSource: string[];
}

async function httpDownload(url: string): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'AVERO-catalog-importer/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error(`Failed to download ${url}: ${String(lastError)}`);
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

interface RehostedImage {
  url: string;
  thumbUrl: string | null;
  mediumUrl: string | null;
  width: number;
  height: number;
}

/** Downloads every image once into MEDIA_DIR/catalog (plus 400/640px variants) and returns public /media URLs. */
async function rehostImages(
  images: NormalizedImage[],
  opts: ImportOptions,
): Promise<{ urls: Map<string, RehostedImage>; downloaded: number }> {
  const dir = join(resolve(opts.mediaDir), 'catalog');
  await mkdir(dir, { recursive: true });
  const download = opts.download ?? httpDownload;
  const urls = new Map<string, RehostedImage>();
  let downloaded = 0;

  const save = async (source: string, file: string) => {
    const target = join(dir, file);
    if (await exists(target)) return;
    const bytes = await download(source);
    const tmp = `${target}.part`;
    await writeFile(tmp, bytes);
    await rename(tmp, target); // atomic: never serve half-written files
    downloaded++;
  };

  const queue = [...images];
  const workers = Array.from({ length: 4 }, async () => {
    for (let img = queue.shift(); img; img = queue.shift()) {
      const safeId = img.externalId.replace(/[^A-Za-z0-9-]/g, '');
      await save(img.sourceUrl, `${safeId}.webp`);
      const url = `/media/catalog/${safeId}.webp`;
      // Our own 400/640px sizes. If sharp can't read the file we fall back to the source's
      // thumbnail, and the start-up backfill retries.
      const sizes = await writeImageVariants(join(dir, `${safeId}.webp`)).catch(() => null);
      if (!sizes && img.sourceThumbUrl) await save(img.sourceThumbUrl, `${safeId}-thumb.webp`);
      urls.set(img.externalId, {
        url,
        thumbUrl: sizes ? thumbUrlFor(url) : img.sourceThumbUrl ? `/media/catalog/${safeId}-thumb.webp` : null,
        mediumUrl: sizes ? mediumUrlFor(url) : null,
        width: sizes?.width ?? 1024,
        height: sizes?.height ?? 1024,
      });
    }
  });
  await Promise.all(workers);
  return { urls, downloaded };
}

async function ensureCategory(tx: Tx, p: NormalizedProduct): Promise<string> {
  await tx
    .insert(categories)
    .values({ slug: p.gender, path: p.gender, name: GENDER_LABELS[p.gender], position: p.gender === 'men' ? 0 : p.gender === 'women' ? 1 : 2 })
    .onConflictDoNothing();
  const parent = await tx.query.categories.findFirst({ where: eq(categories.path, p.gender) });
  await tx
    .insert(categories)
    .values({ slug: p.activity, path: p.categoryPath, name: ACTIVITY_LABELS[p.activity], parentId: parent!.id })
    .onConflictDoNothing();
  const child = await tx.query.categories.findFirst({ where: eq(categories.path, p.categoryPath) });
  return child!.id;
}

export async function importCatalog(db: Db, clock: SimulatedClock, opts: ImportOptions): Promise<ImportReport> {
  const log = opts.log ?? (() => undefined);
  const items = opts.items ?? (await fetchSourcePack(requireUrl(opts.sourceUrl)));
  const importable = items.filter(isImportable);
  const normalized = importable.map(normalizeItem);

  // Disambiguate slug collisions deterministically.
  const seen = new Map<string, number>();
  for (const p of normalized) {
    const n = (seen.get(p.slug) ?? 0) + 1;
    seen.set(p.slug, n);
    if (n > 1) p.slug = `${p.slug}-${n}`;
  }

  const report: ImportReport = {
    dryRun: Boolean(opts.dryRun),
    sourceItems: items.length,
    skipped: items.length - importable.length,
    productsCreated: [],
    productsUpdated: [],
    skusCreated: 0,
    skusDiscontinued: 0,
    imagesDownloaded: 0,
    missingFromSource: [],
  };

  const existing = await db.query.products.findMany({ columns: { externalId: true, slug: true } });
  const sourceIds = new Set(normalized.map((p) => p.externalId));
  report.missingFromSource = existing.filter((e) => e.externalId && !sourceIds.has(e.externalId)).map((e) => e.slug);

  if (opts.dryRun) {
    const known = new Set(existing.map((e) => e.externalId));
    for (const p of normalized) (known.has(p.externalId) ? report.productsUpdated : report.productsCreated).push(p.slug);
    return report;
  }

  log(`Downloading imagery for ${normalized.length} products…`);
  const allImages = normalized.flatMap((p) => p.colorways.flatMap((c) => c.images));
  const { urls, downloaded } = await rehostImages(allImages, opts);
  report.imagesDownloaded = downloaded;

  await ensureSizeCharts(db);
  const charts = await db.select().from(sizeCharts);
  const chartFor = (gender: string) =>
    charts.find((c) => c.name === (gender === 'women' ? 'Women footwear' : 'Men footwear'))?.id ?? null;

  const now = clock.now();

  for (const p of normalized) {
    await db.transaction(async (tx) => {
      const categoryId = await ensureCategory(tx, p);
      const content = {
        slug: p.slug,
        name: p.name,
        shortDescription: p.shortDescription,
        description: p.description,
        highlights: p.highlights,
        tags: p.tags,
        categoryId,
        gender: p.gender,
        attributes: { activity: p.activity },
        sizeChartId: chartFor(p.gender),
        gstRateBps: p.gstRateBps,
      };

      let product = await tx.query.products.findFirst({ where: eq(products.externalId, p.externalId) });
      const isNew = !product;
      if (product) {
        [product] = await tx.update(products).set(content).where(eq(products.id, product.id)).returning();
        report.productsUpdated.push(p.slug);
      } else {
        [product] = await tx
          .insert(products)
          .values({ ...content, externalId: p.externalId, status: 'active', launchedAt: now })
          .returning();
        report.productsCreated.push(p.slug);
      }
      const productId = product!.id;
      const markup = LAUNCH_MRP_MARKUP_BPS[p.slug] ?? 0;
      // MRP uses the same ₹…99 rounding as prices.
      const mrpPaise = markup ? (Math.ceil((p.pricePaise + percentOf(p.pricePaise, markup)) / 10_000) * 100 - 1) * 100 : p.pricePaise;

      for (const [position, c] of p.colorways.entries()) {
        const values = {
          slug: c.slug,
          name: c.name,
          colorFamily: c.colorFamily,
          hex: c.hex,
          position,
          searchDocument: buildSearchDocument(p, c),
        };
        let colorway = await tx.query.colorways.findFirst({ where: eq(colorways.externalId, c.externalId) });
        if (colorway) {
          // Publish a previously image-less colour once imagery exists; never un-publish here.
          const status = colorway.status === 'draft' && c.hasImagery ? 'active' : colorway.status;
          [colorway] = await tx.update(colorways).set({ ...values, status }).where(eq(colorways.id, colorway.id)).returning();
        } else {
          [colorway] = await tx
            .insert(colorways)
            .values({ ...values, productId, externalId: c.externalId, status: c.hasImagery ? 'active' : 'draft' })
            .returning();
        }
        const colorwayId = colorway!.id;

        if (c.images.length > 0) {
          await tx.delete(colorwayImages).where(eq(colorwayImages.colorwayId, colorwayId));
          await tx.insert(colorwayImages).values(
            c.images.map((img) => ({
              colorwayId,
              externalId: img.externalId,
              ...urls.get(img.externalId)!,
              title: img.title,
              alt: img.alt,
              position: img.position,
            })),
          );
        }

        const current = await tx.query.skus.findMany({ where: eq(skus.colorwayId, colorwayId) });
        const byCode = new Map(current.map((s) => [s.skuCode, s]));
        for (const s of c.skus) {
          const found = byCode.get(s.skuCode);
          if (found) {
            const patch: Partial<typeof skus.$inferInsert> = { sizeLabel: s.sizeLabel, sizeSort: s.sizeSort };
            if (opts.reprice) {
              Object.assign(patch, { pricePaise: p.pricePaise, mrpPaise });
              if (p.pricePaise < found.pricePaise) await enqueuePriceDropCheck(tx, colorwayId);
            }
            if (found.status === 'discontinued') patch.status = 'active';
            await tx.update(skus).set(patch).where(eq(skus.id, found.id));
            if (opts.resetStock) {
              const onHand = Math.max(s.initialStock, found.reserved);
              await tx.update(skus).set({ onHand }).where(eq(skus.id, found.id));
              await tx.insert(inventoryMovements).values({
                skuId: found.id,
                deltaOnHand: onHand - found.onHand,
                reason: 'import',
                refType: 'reset_stock',
              });
            }
          } else {
            const [created] = await tx
              .insert(skus)
              .values({
                colorwayId,
                skuCode: s.skuCode,
                sizeLabel: s.sizeLabel,
                sizeSort: s.sizeSort,
                pricePaise: p.pricePaise,
                mrpPaise,
                status: 'active',
                onHand: s.initialStock,
              })
              .returning({ id: skus.id });
            report.skusCreated++;
            if (s.initialStock > 0) {
              await tx.insert(inventoryMovements).values({
                skuId: created!.id,
                deltaOnHand: s.initialStock,
                reason: 'import',
                refType: 'catalog_import',
              });
            }
          }
        }

        const sourceCodes = c.skus.map((s) => s.skuCode);
        if (sourceCodes.length > 0) {
          const gone = await tx
            .update(skus)
            .set({ status: 'discontinued' })
            .where(and(eq(skus.colorwayId, colorwayId), notInArray(skus.skuCode, sourceCodes), eq(skus.status, 'active')))
            .returning({ id: skus.id });
          report.skusDiscontinued += gone.length;
        }
      }
      if (isNew) log(`  + ${p.name}`);
    });
  }

  await seedCollections(db);
  return report;
}

function requireUrl(url: string | undefined): string {
  if (!url) throw new Error('SKU_API_URL is not configured');
  return url;
}

/** Creates merchandising collections if missing; fills empty manual collections; sets missing hero images. */
async function seedCollections(db: Db): Promise<void> {
  for (const seed of COLLECTIONS) {
    let heroImageUrl: string | null = null;
    if (seed.heroFrom) {
      const product = await db.query.products.findFirst({ where: eq(products.slug, seed.heroFrom) });
      if (product) {
        const cws = await db.query.colorways.findMany({ where: eq(colorways.productId, product.id), columns: { id: true } });
        const images = cws.length
          ? await db.query.colorwayImages.findMany({ where: inArray(colorwayImages.colorwayId, cws.map((c) => c.id)) })
          : [];
        heroImageUrl = (seed.heroImageRole ? pickImage(images, seed.heroImageRole) : images[0])?.url ?? null;
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .insert(collections)
        .values({
          slug: seed.slug,
          name: seed.name,
          description: seed.description,
          kind: seed.kind,
          rules: seed.rules,
          heroImageUrl,
          position: seed.position,
        })
        .onConflictDoNothing();
      const collection = await tx.query.collections.findFirst({ where: eq(collections.slug, seed.slug) });
      if (!collection) return;
      // Seeded collections are store-owned config (no admin), so their hero tracks the seed.
      if (heroImageUrl && collection.heroImageUrl !== heroImageUrl) {
        await tx.update(collections).set({ heroImageUrl }).where(eq(collections.id, collection.id));
      }
      if (seed.kind === 'manual' && seed.productSlugs?.length) {
        const hasItems = await tx.query.collectionItems.findFirst({ where: eq(collectionItems.collectionId, collection.id) });
        if (hasItems) return;
        for (const [position, slug] of seed.productSlugs.entries()) {
          const product = await tx.query.products.findFirst({ where: eq(products.slug, slug) });
          if (!product) continue;
          const first = await tx.query.colorways.findFirst({
            where: and(eq(colorways.productId, product.id), eq(colorways.status, 'active')),
          });
          if (first) {
            await tx.insert(collectionItems).values({ collectionId: collection.id, colorwayId: first.id, position }).onConflictDoNothing();
          }
        }
      }
    });
  }
}
