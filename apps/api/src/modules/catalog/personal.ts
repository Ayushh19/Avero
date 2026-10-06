import type { ListingItemDto, PersonalRowDto } from '@avero/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { recentlyViewed, wishlistItems } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { lowestPrice } from '../alerts/price-drops';
import type { IndexedItem } from './catalog-index';
import { toListingDto } from './service';

/**
 * Recommendations beyond "You may also like": frequently bought together (co-purchases in paid
 * orders, topped up with popular products for the same shopper) and personal home rows.
 */

/** One representative colourway per product: in stock first, then catalogue order. */
function representative(items: IndexedItem[]): IndexedItem | undefined {
  return [...items].sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.position - b.position)[0];
}

export async function frequentlyBoughtTogether(ctx: AppContext, productSlug: string, limit = 3): Promise<ListingItemDto[]> {
  const snap = await ctx.catalog.get();
  const now = ctx.clock.now();
  const self = snap.items.find((i) => i.productSlug === productSlug);
  if (!self) throw new AppError('NOT_FOUND', 'Product not found');

  const together = (await ctx.db.execute(sql`
    SELECT b.product_id AS "productId", count(DISTINCT b.order_id)::int AS n
    FROM order_items a
    JOIN order_items b ON b.order_id = a.order_id AND b.product_id <> a.product_id
    JOIN orders o ON o.id = a.order_id
    WHERE a.product_id = ${self.productId} AND o.paid_paise > 0 AND o.kind = 'sale'
    GROUP BY b.product_id
    ORDER BY n DESC
    LIMIT ${limit * 2}`)) as unknown as { rows: { productId: string; n: number }[] };

  const picked: IndexedItem[] = [];
  const add = (item: IndexedItem | undefined) => {
    if (item && item.inStock && item.productId !== self.productId && !picked.some((p) => p.productId === item.productId)) picked.push(item);
  };
  for (const row of together.rows) add(representative(snap.byProduct.get(row.productId) ?? []));
  // Not enough history yet: popular in-stock products for the same shopper (gender), then any.
  const popular = [...snap.byProduct.values()]
    .map(representative)
    .filter((i): i is IndexedItem => Boolean(i))
    .sort((a, b) => Number(b.gender === self.gender || b.gender === 'unisex') - Number(a.gender === self.gender || a.gender === 'unisex') || b.soldCount - a.soldCount);
  for (const item of popular) {
    if (picked.length >= limit) break;
    add(item);
  }
  return picked.slice(0, limit).map((i) => toListingDto(i, snap, now));
}

/**
 * Home rows for a returning visitor. Members: their recently viewed + wishlist. Guests: the
 * colourways their device has viewed (passed by the client, which keeps that list locally).
 */
export async function personalRows(ctx: AppContext, userId: string | null, guestViewed: string[]): Promise<PersonalRowDto[]> {
  const snap = await ctx.catalog.get();
  const now = ctx.clock.now();
  const rows: PersonalRowDto[] = [];

  const viewedIds = userId
    ? (await ctx.db.select({ id: recentlyViewed.colorwayId }).from(recentlyViewed).where(eq(recentlyViewed.userId, userId)).orderBy(desc(recentlyViewed.viewedAt)).limit(20)).map(
        (r) => r.id,
      )
    : guestViewed;
  const viewed = viewedIds.map((id) => snap.byColorway.get(id)).filter((i): i is IndexedItem => Boolean(i));
  if (viewed.length) {
    const viewedProducts = new Set(viewed.map((v) => v.productId));
    const categories = new Set(viewed.map((v) => v.categoryPath.split('/')[0]));
    const activities = new Set(viewed.map((v) => v.activity));
    const picks = [...snap.byProduct.values()]
      .map(representative)
      .filter((i): i is IndexedItem => Boolean(i) && i!.inStock && !viewedProducts.has(i!.productId))
      .map((i) => ({
        i,
        score: (categories.has(i.categoryPath.split('/')[0]) ? 3 : 0) + (activities.has(i.activity) ? 2 : 0) + (i.rating?.value ?? 0) / 5 + Math.min(i.soldCount, 50) / 50,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ i }) => toListingDto(i, snap, now));
    if (picks.length) rows.push({ key: 'picked_for_you', title: 'Picked for you', items: picks });
  }

  if (userId) {
    const wished = await ctx.db.query.wishlistItems.findMany({ where: eq(wishlistItems.userId, userId) });
    const dropped: ListingItemDto[] = [];
    for (const w of wished) {
      const item = snap.byColorway.get(w.colorwayId);
      const price = await lowestPrice(ctx.db, w.colorwayId);
      if (item && item.inStock && w.addedPricePaise && price !== null && price < w.addedPricePaise) dropped.push(toListingDto(item, snap, now));
    }
    if (dropped.length) rows.push({ key: 'wishlist_price_drops', title: 'Wishlist price drops', items: dropped.slice(0, 8) });
  }
  return rows;
}

