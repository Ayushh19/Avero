import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSearchQuery, searchParamsFor } from '@avero/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { colorwayImages, colorways, inventoryMovements, skus } from '../src/db/schema';
import { backfillImageVariants } from '../src/lib/media';
import { estimateDelivery, lookupPincode } from '../src/modules/delivery/pincode';
import { convertPrice, normalizeItem } from '../src/modules/catalog/importer/normalize';
import { importCatalog } from '../src/modules/catalog/importer/run';
import { sourcePackSchema, type SourceItem } from '../src/modules/catalog/importer/source';
import { api, client, createTestApp, testEnv } from './helpers';

const fixture: SourceItem[] = sourcePackSchema.parse(
  JSON.parse(readFileSync(new URL('./fixtures/scenesku-shoes.json', import.meta.url), 'utf8')),
).data;
const fakeDownload = async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]);
const bySlug = (slug: string) => normalizeItem(fixture.find((i) => normalizeItem(i).slug === slug)!);

describe('catalog normalisation', () => {
  it('infers gender, activity and category from source data', () => {
    expect(bySlug('mens-gray-low-top-sneakers')).toMatchObject({ gender: 'men', activity: 'sneakers', categoryPath: 'men/sneakers' });
    expect(bySlug('womens-pink-training-shoes')).toMatchObject({ gender: 'women', activity: 'training' });
    // No gender category in source: inferred from title, "Women's" checked before "Men's".
    expect(bySlug('fluorescent-green-womens-running-shoes')).toMatchObject({ gender: 'women', activity: 'running' });
    expect(bySlug('womens-white-low-top-canvas-shoes')).toMatchObject({ activity: 'casual' });
  });

  it('converts USD to INR with ₹…99 pricing and sets GST', () => {
    expect(convertPrice('65')).toBe(539900);
    expect(convertPrice('80')).toBe(669900);
    expect(convertPrice('100')).toBe(829900);
    expect(bySlug('mens-gray-low-top-sneakers').gstRateBps).toBe(1800);
  });

  it('builds one SKU per size with stable codes and stock', () => {
    const p = bySlug('mens-gray-low-top-sneakers');
    const cw = p.colorways[0]!;
    expect(cw).toMatchObject({ name: 'Gray', colorFamily: 'grey', hasImagery: true });
    expect(cw.skus.map((s) => s.sizeLabel)).toEqual(['6', '6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10']);
    expect(cw.skus[1]!.skuCode).toMatch(/^AV-[0-9A-F]{6}-GRA-6H5$/);
    expect(bySlug('mens-gray-low-top-sneakers').colorways[0]!.skus).toEqual(cw.skus); // deterministic
    expect(cw.images).toHaveLength(8);
  });

  it('resolves multi-colour names and keeps extra colours as drafts without imagery', () => {
    const blue = bySlug('modern-blue-purple-sneakers').colorways[0]!;
    expect(blue).toMatchObject({ name: 'Blue & Purple', colorFamily: 'blue' });
    const multi = normalizeItem({
      ...fixture[0]!,
      product_data: { ...fixture[0]!.product_data, options: { Color: ['Gray', 'black'], Size: ['8'] } },
    });
    expect(multi.colorways.map((c) => [c.name, c.hasImagery, c.images.length])).toEqual([
      ['Gray', true, 8],
      ['Black', false, 0],
    ]);
  });
});

describe('search query parsing', () => {
  it.each([
    ['black sneakers', { color: ['black'], activity: ['sneakers'], text: '' }],
    ['shoes under ₹5000', { priceMax: 5000, text: '' }],
    ['shoes under 5k', { priceMax: 5000 }],
    ['grey size 9', { color: ['grey'], size: ['9'], text: '' }],
    ["women's running between 3k and 7,000", { gender: ['women'], activity: ['running'], priceMin: 3000, priceMax: 7000 }],
    ['trainers above rs 6000', { activity: ['sneakers'], priceMin: 6000 }],
    ['snekers', { text: 'snekers' }],
  ])('%s', (q, expected) => {
    expect(parseSearchQuery(q)).toMatchObject(expected);
  });

  it('turns a query into explicit URL filters', () => {
    expect(searchParamsFor('grey running shoes size 9 under 7k').toString()).toBe(
      'qraw=grey+running+shoes+size+9+under+7k&activity=running&color=grey&size=9&priceMax=7000',
    );
    expect(searchParamsFor('canvs').get('q')).toBe('canvs');
  });
});

describe('pincode & delivery', () => {
  it('looks up state and metro express coverage', () => {
    expect(lookupPincode('400706')).toMatchObject({ serviceable: true, express: true, city: 'Mumbai', state: 'Maharashtra' });
    expect(lookupPincode('641001')).toMatchObject({ serviceable: true, express: false, state: 'Tamil Nadu' });
    expect(lookupPincode('744101').serviceable).toBe(false);
    expect(lookupPincode('012345').valid).toBe(false);
  });

  it('skips Sundays and applies the dispatch cut-off (IST)', () => {
    // Fri 09 Oct 2026, 10:00 IST → standard 3–6 days excl. Sunday → Tue 13 .. Fri 16
    const morning = estimateDelivery('560001', new Date('2026-10-09T04:30:00Z'));
    expect(morning.options[0]).toMatchObject({ earliest: '2026-10-13', latest: '2026-10-16' });
    // Same day 16:00 IST is after cut-off → dispatch Saturday
    const evening = estimateDelivery('560001', new Date('2026-10-09T10:30:00Z'));
    expect(evening.options[0]!.earliest).toBe('2026-10-14');
  });
});

describe('catalog import + API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
    await app.ready();
    await importCatalog(app.ctx.db, app.ctx.clock, { items: fixture, mediaDir: testEnv.MEDIA_DIR, download: fakeDownload });
  });
  afterAll(() => app.close());

  it('imports products, SKUs, stock movements and collections', async () => {
    const res = await client(app).get(api('/products'));
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(5);
    const movements = await app.ctx.db.select().from(inventoryMovements);
    expect(movements.every((m) => m.reason === 'import' && m.deltaOnHand > 0)).toBe(true);
    const collections = (await client(app).get(api('/collections'))).json().collections;
    expect(collections.map((c: { slug: string }) => c.slug)).toEqual(['new-arrivals', 'best-sellers', 'running', 'lifestyle']);
  });

  it('re-import is idempotent and never overwrites our prices or stock', async () => {
    const sku = (await app.ctx.db.select().from(skus).limit(1))[0]!;
    await app.ctx.db.update(skus).set({ pricePaise: 499900, onHand: 3 }).where(eq(skus.id, sku.id));
    const report = await importCatalog(app.ctx.db, app.ctx.clock, { items: fixture, mediaDir: testEnv.MEDIA_DIR, download: fakeDownload });
    expect(report.productsCreated).toEqual([]);
    expect(report.skusCreated).toBe(0);
    expect(report.imagesDownloaded).toBe(0);
    const after = await app.ctx.db.query.skus.findFirst({ where: eq(skus.id, sku.id) });
    expect(after).toMatchObject({ pricePaise: 499900, onHand: 3 });
  });

  it('discontinues sizes that disappear from the source', async () => {
    const trimmed = fixture.map((item, i) =>
      i === 0 ? { ...item, product_data: { ...item.product_data, options: { ...item.product_data.options, Size: ['8', '9'] } } } : item,
    );
    const report = await importCatalog(app.ctx.db, app.ctx.clock, { items: trimmed, mediaDir: testEnv.MEDIA_DIR, download: fakeDownload });
    expect(report.skusDiscontinued).toBe(7);
    app.ctx.catalog.invalidate();
    const pdp = (await client(app).get(api('/products/mens-gray-low-top-sneakers'))).json().product;
    const states = Object.fromEntries(pdp.colorways[0].skus.map((s: { sizeLabel: string; state: string }) => [s.sizeLabel, s.state]));
    expect(states['6']).toBe('unavailable');
    // restore
    await importCatalog(app.ctx.db, app.ctx.clock, { items: fixture, mediaDir: testEnv.MEDIA_DIR, download: fakeDownload });
    app.ctx.catalog.invalidate();
  });

  it('makes 400/640px variants of each original and backfills images imported without them', async () => {
    // The fixture download returns bytes sharp can't read, so the import keeps originals only.
    const [img] = await app.ctx.db.select().from(colorwayImages).where(eq(colorwayImages.position, 0)).limit(1);
    expect(img).toMatchObject({ mediumUrl: null, thumbUrl: expect.stringMatching(/-thumb\.webp$/), width: 1024, height: 1024 });

    const original = join(testEnv.MEDIA_DIR, img!.url.slice('/media/'.length));
    await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#d9d4c7' } }).webp().toFile(original);
    expect(await backfillImageVariants(app.ctx, app.log)).toBe(1);

    const after = await app.ctx.db.query.colorwayImages.findFirst({ where: eq(colorwayImages.id, img!.id) });
    expect(after).toMatchObject({ thumbUrl: img!.url.replace(/\.webp$/, '-400.webp'), mediumUrl: img!.url.replace(/\.webp$/, '-640.webp'), width: 1200, height: 900 });
    for (const [w, h] of [[400, 300], [640, 480]]) {
      const variant = await sharp(original.replace(/\.webp$/, `-${w}.webp`)).metadata();
      expect([variant.width, variant.height]).toEqual([w, h]);
    }
    // Unreadable files are left for next time; a second run does nothing new.
    expect(await backfillImageVariants(app.ctx, app.log)).toBe(0);

    const listing = (await client(app).get(api('/products?limit=48'))).json();
    const images = listing.items.map((i: { image: { url: string; mediumUrl: string | null } }) => i.image);
    expect(images.find((i: { url: string }) => i.url === img!.url)?.mediumUrl).toBe(after!.mediumUrl);
  });

  it('lets browsers briefly cache public catalogue reads but never product detail (live stock)', async () => {
    const c = client(app);
    expect((await c.get(api('/products'))).headers['cache-control']).toMatch(/^public, max-age=30/);
    expect((await c.get(api('/pincodes/560038'))).headers['cache-control']).toBe('public, max-age=86400');
    expect((await c.get(api('/products/mens-gray-low-top-sneakers'))).headers['cache-control']).toBe('no-store');
  });

  it('filters by category and computes facets excluding their own dimension', async () => {
    const res = (await client(app).get(api('/products?category=women&color=pink'))).json();
    expect(res.items.map((i: { name: string }) => i.name)).toEqual(["Women's Pink Training Shoes"]);
    // colour facet still shows other women's colours so shoppers can switch
    expect(res.facets.color.map((f: { value: string }) => f.value).sort()).toEqual(['green', 'pink', 'white']);
    expect(res.context.title).toBe("Women's Shoes");
    expect(res.facets.onSale).toBe(1);
  });

  it('understands natural language search and is typo tolerant', async () => {
    const under = (await client(app).get(api(`/products?q=${encodeURIComponent('shoes under ₹6000')}`))).json();
    expect(under.total).toBe(2);
    expect(under.interpretation.priceMax).toBe(6000);
    const typo = (await client(app).get(api('/products?q=snekers'))).json();
    expect(typo.items.map((i: { name: string }) => i.name)).toContain("Men's Gray Low-Top Sneakers");
    expect(typo.sort).toBe('relevance');
  });

  it('suggests broader searches when nothing matches', async () => {
    const res = (await client(app).get(api(`/products?q=${encodeURIComponent('black sneakers')}`))).json();
    expect(res.total).toBe(0);
    expect(res.relaxations[0]).toMatchObject({ label: 'Sneakers', count: 2, params: { color: '', activity: 'sneakers' } });
  });

  it('serves PDP with live stock states and hides exact counts unless low', async () => {
    const pdp = (await client(app).get(api('/products/womens-pink-training-shoes'))).json().product;
    expect(pdp.category).toMatchObject({ path: 'women/training', parent: { path: 'women' } });
    expect(pdp.sizeChart.name).toBe('Women footwear');
    const sku = pdp.colorways[0].skus[0];
    expect(sku.mrpPaise).toBeGreaterThan(sku.pricePaise);
    for (const s of pdp.colorways[0].skus) {
      if (s.state !== 'low') expect(s.left).toBeNull();
    }
    expect((await client(app).get(api('/products/nope'))).statusCode).toBe(404);
  });

  it('recommends similar products, excluding itself', async () => {
    const items = (await client(app).get(api('/products/womens-pink-training-shoes/recommendations'))).json().items;
    expect(items[0].gender).toBe('women');
    expect(items.some((i: { name: string }) => i.name === "Women's Pink Training Shoes")).toBe(false);
  });

  it('returns 404 for unknown categories and grouped suggestions', async () => {
    expect((await client(app).get(api('/products?category=kids'))).statusCode).toBe(404);
    const s = (await client(app).get(api('/search/suggest?q=run'))).json();
    expect(s.products[0].name).toMatch(/Running/);
    expect(s.categories).toContainEqual({ label: "Women's Running", to: '/c/women/running' });
  });

  it('draft colourways are not listed', async () => {
    const all = await app.ctx.db.select().from(colorways);
    expect(all.every((c) => c.status === 'active')).toBe(true);
  });
});
