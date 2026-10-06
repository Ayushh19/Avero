import type { ListingItemDto, WishlistItemDto } from '@avero/shared';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { colorwayImages, colorways, products, recentlyViewed, skus, stockAlerts, users, wishlistItems } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { enqueue } from '../../jobs/queue';
import { notify } from '../notifications/service';
import { toListingDto } from '../catalog/service';

const RECENT_LIMIT = 20;

/**
 * Listing cards for arbitrary colourways, including ones no longer purchasable
 * (shown as sold out rather than silently disappearing from a wishlist).
 */
export async function cardsFor(ctx: AppContext, colorwayIds: string[]): Promise<Map<string, ListingItemDto>> {
  const out = new Map<string, ListingItemDto>();
  if (colorwayIds.length === 0) return out;
  const snap = await ctx.catalog.get();
  const now = ctx.clock.now();
  const missing: string[] = [];
  for (const id of colorwayIds) {
    const item = snap.byColorway.get(id);
    if (item) out.set(id, toListingDto(item, snap, now));
    else missing.push(id);
  }
  if (missing.length) {
    const rows = await ctx.db
      .select({ colorway: colorways, product: products, price: sql<number>`min(${skus.pricePaise})`, mrp: sql<number>`min(${skus.mrpPaise})` })
      .from(colorways)
      .innerJoin(products, eq(products.id, colorways.productId))
      .leftJoin(skus, eq(skus.colorwayId, colorways.id))
      .where(inArray(colorways.id, missing))
      .groupBy(colorways.id, products.id);
    const images = await ctx.db
      .select()
      .from(colorwayImages)
      .where(and(inArray(colorwayImages.colorwayId, missing), eq(colorwayImages.position, 0)));
    for (const r of rows) {
      if (r.product.status === 'draft' || r.colorway.status === 'draft') continue;
      const img = images.find((i) => i.colorwayId === r.colorway.id);
      out.set(r.colorway.id, {
        colorwayId: r.colorway.id,
        productId: r.product.id,
        href: `/p/${r.product.slug}/${r.colorway.slug}`,
        name: r.product.name,
        colorName: r.colorway.name,
        colorFamily: r.colorway.colorFamily,
        hex: r.colorway.hex ?? '#B8B2A7',
        image: img ? { url: img.url, thumbUrl: img.thumbUrl, mediumUrl: img.mediumUrl, alt: img.alt } : null,
        hoverImage: null,
        pricePaise: Number(r.price ?? 0),
        mrpPaise: Number(r.mrp ?? 0),
        badge: null,
        swatches: [],
        rating: null,
        inStock: false,
        gender: r.product.gender,
        activity: '',
      });
    }
  }
  return out;
}

export async function listWishlist(ctx: AppContext, userId: string): Promise<WishlistItemDto[]> {
  const rows = await ctx.db.query.wishlistItems.findMany({ where: eq(wishlistItems.userId, userId), orderBy: desc(wishlistItems.createdAt) });
  const cards = await cardsFor(ctx, rows.map((r) => r.colorwayId));
  return rows.flatMap((r) => {
    const card = cards.get(r.colorwayId);
    return card ? [{ ...card, addedAt: r.createdAt.toISOString(), addedPricePaise: r.addedPricePaise }] : [];
  });
}

async function assertColorway(ctx: AppContext, colorwayId: string) {
  const cw = await ctx.db.query.colorways.findFirst({ where: eq(colorways.id, colorwayId) });
  if (!cw || cw.status === 'draft') throw new AppError('NOT_FOUND', 'Product not found');
}

async function currentPrice(ctx: AppContext, colorwayId: string): Promise<number | null> {
  const [row] = await ctx.db
    .select({ price: sql<number>`min(${skus.pricePaise})` })
    .from(skus)
    .where(and(eq(skus.colorwayId, colorwayId), eq(skus.status, 'active')));
  return row?.price ? Number(row.price) : null;
}

export async function addToWishlist(ctx: AppContext, userId: string, colorwayId: string): Promise<void> {
  await assertColorway(ctx, colorwayId);
  await ctx.db
    .insert(wishlistItems)
    .values({ userId, colorwayId, addedPricePaise: await currentPrice(ctx, colorwayId) })
    .onConflictDoNothing();
}

export async function removeFromWishlist(ctx: AppContext, userId: string, colorwayId: string): Promise<void> {
  await ctx.db.delete(wishlistItems).where(and(eq(wishlistItems.userId, userId), eq(wishlistItems.colorwayId, colorwayId)));
}

/** Union of the device's guest wishlist into the account (never removes anything). */
export async function mergeWishlist(ctx: AppContext, userId: string, colorwayIds: string[]): Promise<number> {
  if (colorwayIds.length === 0) return 0;
  const valid = await ctx.db
    .select({ id: colorways.id })
    .from(colorways)
    .where(and(inArray(colorways.id, colorwayIds), notInArray(colorways.status, ['draft'])));
  let added = 0;
  for (const { id } of valid) {
    const inserted = await ctx.db
      .insert(wishlistItems)
      .values({ userId, colorwayId: id, addedPricePaise: await currentPrice(ctx, id) })
      .onConflictDoNothing()
      .returning({ id: wishlistItems.id });
    added += inserted.length;
  }
  return added;
}

/* ---------- recently viewed ---------- */

/** Records views (most recent first in the array) and keeps the newest 20. */
export async function recordViews(ctx: AppContext, userId: string, colorwayIds: string[]): Promise<void> {
  const now = ctx.clock.now().getTime();
  const valid = new Set(
    (await ctx.db.select({ id: colorways.id }).from(colorways).where(inArray(colorways.id, colorwayIds))).map((r) => r.id),
  );
  await ctx.db.transaction(async (tx) => {
    // Iterate oldest → newest so the first id ends up most recent.
    for (const [i, id] of [...colorwayIds].reverse().entries()) {
      if (!valid.has(id)) continue;
      const viewedAt = new Date(now - (colorwayIds.length - 1 - i));
      await tx
        .insert(recentlyViewed)
        .values({ userId, colorwayId: id, viewedAt })
        .onConflictDoUpdate({
          target: [recentlyViewed.userId, recentlyViewed.colorwayId],
          set: { viewedAt: sql`greatest(${recentlyViewed.viewedAt}, excluded.viewed_at)` },
        });
    }
    const keep = await tx
      .select({ id: recentlyViewed.id })
      .from(recentlyViewed)
      .where(eq(recentlyViewed.userId, userId))
      .orderBy(desc(recentlyViewed.viewedAt))
      .limit(RECENT_LIMIT);
    if (keep.length === RECENT_LIMIT) {
      await tx.delete(recentlyViewed).where(and(eq(recentlyViewed.userId, userId), notInArray(recentlyViewed.id, keep.map((k) => k.id))));
    }
  });
}

export async function listRecentlyViewed(ctx: AppContext, userId: string): Promise<ListingItemDto[]> {
  const rows = await ctx.db.query.recentlyViewed.findMany({
    where: eq(recentlyViewed.userId, userId),
    orderBy: desc(recentlyViewed.viewedAt),
    limit: RECENT_LIMIT,
  });
  const cards = await cardsFor(ctx, rows.map((r) => r.colorwayId));
  return rows.flatMap((r) => cards.get(r.colorwayId) ?? []);
}

/* ---------- back-in-stock alerts ---------- */

export async function createStockAlert(ctx: AppContext, input: { skuId: string; email: string; userId: string | null }): Promise<void> {
  const sku = await ctx.db.query.skus.findFirst({ where: eq(skus.id, input.skuId) });
  if (!sku) throw new AppError('NOT_FOUND', 'Size not found');
  const pending = await ctx.db.query.stockAlerts.findFirst({
    where: and(eq(stockAlerts.skuId, sku.id), eq(stockAlerts.email, input.email), eq(stockAlerts.kind, 'back_in_stock'), isNull(stockAlerts.notifiedAt)),
  });
  if (pending) return;
  await ctx.db.insert(stockAlerts).values({
    userId: input.userId,
    email: input.email,
    kind: 'back_in_stock',
    skuId: sku.id,
    colorwayId: sku.colorwayId,
  });
  // If it is already back in stock, notify right away.
  if (sku.onHand - sku.reserved > 0 && sku.status === 'active') {
    await enqueue(ctx.db, 'stock_alert.check', { skuId: sku.id }, { dedupeKey: `stock-alert:${sku.id}` });
  }
}

/** Job: notify everyone waiting for a SKU that is purchasable again. */
export async function processStockAlerts(ctx: AppContext, skuId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ sku: skus, colorway: colorways, product: products })
    .from(skus)
    .innerJoin(colorways, eq(colorways.id, skus.colorwayId))
    .innerJoin(products, eq(products.id, colorways.productId))
    .where(eq(skus.id, skuId));
  if (!row || row.sku.status !== 'active' || row.sku.onHand - row.sku.reserved <= 0) return;

  const alerts = await ctx.db.query.stockAlerts.findMany({
    where: and(eq(stockAlerts.skuId, skuId), eq(stockAlerts.kind, 'back_in_stock'), isNull(stockAlerts.notifiedAt)),
    orderBy: asc(stockAlerts.createdAt),
  });
  const link = `/p/${row.product.slug}/${row.colorway.slug}`;
  const title = `${row.product.name} is back in size ${row.sku.sizeLabel}`;
  for (const alert of alerts) {
    await ctx.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(stockAlerts)
        .set({ notifiedAt: ctx.clock.now() })
        .where(and(eq(stockAlerts.id, alert.id), isNull(stockAlerts.notifiedAt)))
        .returning();
      if (!claimed) return;
      const url = `${ctx.env.WEB_ORIGIN}${link}`;
      // Guests (alert by email only) have no account to hold an in-app notification or preferences.
      await notify(ctx, tx, {
        userId: alert.userId,
        kind: 'stock_alert',
        title,
        body: `${row.colorway.name} · Size ${row.sku.sizeLabel}`,
        link,
        email: {
          to: alert.email,
          template: 'back_in_stock',
          subject: `Back in stock: ${row.product.name}`,
          text: `${title} (${row.colorway.name}). It may sell out again quickly: ${url}`,
          html: `<p><strong>${title}</strong> (${row.colorway.name}).</p><p>It may sell out again quickly.</p><p><a href="${url}">Shop now</a></p>`,
        },
      });
    });
  }
}

export async function userEmail(ctx: AppContext, userId: string): Promise<string> {
  const u = await ctx.db.query.users.findFirst({ where: eq(users.id, userId), columns: { email: true } });
  return u!.email;
}
