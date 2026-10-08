import {
  includedGst,
  type CartDto,
  type CartLineDto,
  type CartLineIssue,
  type CartMutationResponse,
} from '@avero/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import type { DbOrTx } from '../../db/client';
import { cartItems, carts, colorwayImages, colorways, products, skus } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import { AppError } from '../../lib/errors';

export const CART_COOKIE = 'avero_cart';
const CART_COOKIE_DAYS = 60;

type CartRow = typeof carts.$inferSelect;

export function setCartCookie(ctx: AppContext, reply: FastifyReply, token: string) {
  reply.setCookie(CART_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.env.NODE_ENV === 'production',
    maxAge: CART_COOKIE_DAYS * 86_400,
  });
}

/** Finds the shopper's active bag (user bag when signed in, else guest token). Optionally creates it. */
export async function resolveCart(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply | null,
  create: boolean,
): Promise<CartRow | null> {
  if (req.user) {
    const existing = await ctx.db.query.carts.findFirst({
      where: and(eq(carts.userId, req.user.id), eq(carts.status, 'active')),
    });
    if (existing || !create) return existing ?? null;
    const [created] = await ctx.db.insert(carts).values({ userId: req.user.id }).onConflictDoNothing().returning();
    return created ?? (await ctx.db.query.carts.findFirst({ where: and(eq(carts.userId, req.user.id), eq(carts.status, 'active')) })) ?? null;
  }

  const token = req.cookies[CART_COOKIE];
  if (token) {
    const existing = await ctx.db.query.carts.findFirst({
      where: and(eq(carts.guestTokenHash, sha256(token)), eq(carts.status, 'active')),
    });
    if (existing) return existing;
  }
  if (!create || !reply) return null;
  const fresh = randomToken();
  const [created] = await ctx.db.insert(carts).values({ guestTokenHash: sha256(fresh) }).returning();
  setCartCookie(ctx, reply, fresh);
  return created!;
}

export interface LineRow {
  item: typeof cartItems.$inferSelect;
  sku: typeof skus.$inferSelect;
  colorway: typeof colorways.$inferSelect;
  product: typeof products.$inferSelect;
}

export async function loadLines(db: DbOrTx, cartId: string): Promise<LineRow[]> {
  return db
    .select({ item: cartItems, sku: skus, colorway: colorways, product: products })
    .from(cartItems)
    .innerJoin(skus, eq(skus.id, cartItems.skuId))
    .innerJoin(colorways, eq(colorways.id, skus.colorwayId))
    .innerJoin(products, eq(products.id, colorways.productId))
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(cartItems.createdAt));
}

/** Max units purchasable right now for a SKU (0 if not purchasable). */
export function capFor(row: Pick<LineRow, 'sku' | 'colorway' | 'product'>): number {
  const purchasable = row.product.status === 'active' && row.colorway.status === 'active' && row.sku.status === 'active';
  if (!purchasable) return 0;
  return Math.max(0, Math.min(row.sku.onHand - row.sku.reserved, row.sku.maxPerOrder));
}

const emptyTotals = (): CartDto['totals'] => ({
  itemCount: 0,
  subtotalPaise: 0,
  savingsPaise: 0,
  shippingPaise: 0,
  freeShippingThresholdPaise: business.freeShippingThresholdPaise,
  freeShippingRemainingPaise: business.freeShippingThresholdPaise,
  totalPaise: 0,
  taxIncludedPaise: 0,
});

export async function buildCartDto(ctx: AppContext, cart: CartRow | null): Promise<CartDto> {
  if (!cart) return { id: null, version: 0, lines: [], savedForLater: [], totals: emptyTotals(), hasBlockingIssues: false };

  const rows = await loadLines(ctx.db, cart.id);
  const images = rows.length
    ? await ctx.db
        .select()
        .from(colorwayImages)
        .where(and(inArray(colorwayImages.colorwayId, [...new Set(rows.map((r) => r.colorway.id))]), eq(colorwayImages.position, 0)))
    : [];
  const imageBy = new Map(images.map((i) => [i.colorwayId, i]));

  const toLine = (r: LineRow): CartLineDto & { gstRateBps: number } => {
    const cap = capFor(r);
    const purchasable = r.product.status === 'active' && r.colorway.status === 'active' && r.sku.status === 'active';
    const available = r.sku.onHand - r.sku.reserved;
    const issues: CartLineIssue[] = [];
    if (!purchasable) issues.push({ type: 'unavailable', blocking: true });
    else if (available <= 0) issues.push({ type: 'out_of_stock', blocking: true });
    else if (r.item.qty > cap) issues.push({ type: 'insufficient_stock', blocking: false, maxQty: cap });
    if (purchasable && r.item.priceSeenPaise !== r.sku.pricePaise) {
      issues.push({ type: 'price_changed', blocking: false, fromPaise: r.item.priceSeenPaise, toPaise: r.sku.pricePaise });
    }
    const effectiveQty = issues.some((i) => i.blocking) ? 0 : Math.min(r.item.qty, cap);
    const img = imageBy.get(r.colorway.id);
    return {
      id: r.item.id,
      skuId: r.sku.id,
      skuCode: r.sku.skuCode,
      productName: r.product.name,
      productSlug: r.product.slug,
      colorwayId: r.colorway.id,
      colorName: r.colorway.name,
      sizeLabel: r.sku.sizeLabel,
      href: `/p/${r.product.slug}/${r.colorway.slug}`,
      image: img ? { url: img.url, thumbUrl: img.thumbUrl, mediumUrl: img.mediumUrl, alt: img.alt } : null,
      qty: r.item.qty,
      maxQty: cap,
      unitPricePaise: r.sku.pricePaise,
      mrpPaise: r.sku.mrpPaise,
      lineTotalPaise: r.sku.pricePaise * effectiveQty,
      savedForLater: r.item.savedForLater,
      stockState: !purchasable || available <= 0 ? 'unavailable' : available <= r.sku.lowStockThreshold ? 'low' : 'available',
      issues,
      gstRateBps: r.product.gstRateBps,
    };
  };

  const all = rows.map(toLine);
  const inBag = all.filter((l) => !l.savedForLater);
  const counted = inBag.filter((l) => !l.issues.some((i) => i.blocking));
  const qtyOf = (l: CartLineDto) => Math.min(l.qty, l.maxQty);

  const subtotal = counted.reduce((s, l) => s + l.lineTotalPaise, 0);
  const savings = counted.reduce((s, l) => s + (l.mrpPaise - l.unitPricePaise) * qtyOf(l), 0);
  const threshold = business.freeShippingThresholdPaise;
  const shipping = subtotal === 0 || subtotal >= threshold ? 0 : business.shipping.standard.feePaise;
  const strip = ({ gstRateBps: _g, ...l }: CartLineDto & { gstRateBps: number }): CartLineDto => l;

  return {
    id: cart.id,
    version: cart.version,
    lines: inBag.map(strip),
    savedForLater: all.filter((l) => l.savedForLater).map(strip),
    totals: {
      itemCount: counted.reduce((s, l) => s + qtyOf(l), 0),
      subtotalPaise: subtotal,
      savingsPaise: savings,
      shippingPaise: shipping,
      freeShippingThresholdPaise: threshold,
      freeShippingRemainingPaise: subtotal >= threshold ? 0 : threshold - subtotal,
      totalPaise: subtotal + shipping,
      taxIncludedPaise: counted.reduce((s, l) => s + includedGst(l.lineTotalPaise, l.gstRateBps), 0),
    },
    hasBlockingIssues: inBag.some((l) => l.issues.some((i) => i.blocking)),
  };
}

export async function bumpVersion(db: DbOrTx, cartId: string): Promise<void> {
  await db.update(carts).set({ version: sql`${carts.version} + 1` }).where(eq(carts.id, cartId));
}

export async function skuWithParents(db: DbOrTx, skuId: string) {
  const [row] = await db
    .select({ sku: skus, colorway: colorways, product: products })
    .from(skus)
    .innerJoin(colorways, eq(colorways.id, skus.colorwayId))
    .innerJoin(products, eq(products.id, colorways.productId))
    .where(eq(skus.id, skuId))
    .limit(1);
  return row;
}

function assertVersion(cart: CartRow, expected: number | undefined) {
  if (expected !== undefined && expected !== cart.version) {
    throw new AppError('CART_VERSION_CONFLICT', 'Your bag was updated on another device. We’ve refreshed it.');
  }
}

const sizeNote = (cap: number) => (cap === 1 ? 'Only 1 is available' : `Only ${cap} are available`);

export async function addItem(ctx: AppContext, cart: CartRow, skuId: string, qty: number): Promise<CartMutationResponse> {
  const notice = await ctx.db.transaction(async (tx) => {
    const row = await skuWithParents(tx, skuId);
    if (!row) throw new AppError('NOT_FOUND', 'This product could not be found');
    const purchasable = row.product.status === 'active' && row.colorway.status === 'active' && row.sku.status === 'active';
    if (!purchasable) throw new AppError('SKU_UNAVAILABLE', 'This size is no longer available');
    const cap = capFor(row);
    if (cap <= 0) throw new AppError('SKU_OUT_OF_STOCK', `Size ${row.sku.sizeLabel} just sold out`);

    const existing = await tx.query.cartItems.findFirst({
      where: and(eq(cartItems.cartId, cart.id), eq(cartItems.skuId, skuId), eq(cartItems.savedForLater, false)),
    });
    const desired = (existing?.qty ?? 0) + qty;
    const next = Math.min(desired, cap);
    if (existing) {
      if (existing.qty >= cap) {
        throw new AppError('SKU_OUT_OF_STOCK', `${sizeNote(cap)} in size ${row.sku.sizeLabel}, and they’re already in your bag`);
      }
      await tx.update(cartItems).set({ qty: next, priceSeenPaise: row.sku.pricePaise }).where(eq(cartItems.id, existing.id));
    } else {
      await tx.insert(cartItems).values({ cartId: cart.id, skuId, qty: next, priceSeenPaise: row.sku.pricePaise });
    }
    // An item saved for later that is added again lives only in the bag.
    await tx.delete(cartItems).where(and(eq(cartItems.cartId, cart.id), eq(cartItems.skuId, skuId), eq(cartItems.savedForLater, true)));
    await bumpVersion(tx, cart.id);
    return next < desired ? `${sizeNote(cap)} in size ${row.sku.sizeLabel}, so we added ${next - (existing?.qty ?? 0)}` : undefined;
  });
  return { cart: await buildCartDto(ctx, await reload(ctx, cart.id)), notice };
}

export async function updateItem(
  ctx: AppContext,
  cart: CartRow,
  itemId: string,
  patch: { qty?: number; savedForLater?: boolean; expectedVersion?: number },
): Promise<CartMutationResponse> {
  assertVersion(cart, patch.expectedVersion);
  const notice = await ctx.db.transaction(async (tx) => {
    const item = await tx.query.cartItems.findFirst({ where: and(eq(cartItems.id, itemId), eq(cartItems.cartId, cart.id)) });
    if (!item) throw new AppError('NOT_FOUND', 'This item is no longer in your bag');
    const row = await skuWithParents(tx, item.skuId);
    const cap = row ? capFor(row) : 0;
    let message: string | undefined;

    if (patch.savedForLater !== undefined && patch.savedForLater !== item.savedForLater) {
      const twin = await tx.query.cartItems.findFirst({
        where: and(eq(cartItems.cartId, cart.id), eq(cartItems.skuId, item.skuId), eq(cartItems.savedForLater, patch.savedForLater)),
      });
      if (twin) {
        // Merge into the existing line on the other side.
        const qty = patch.savedForLater ? Math.max(twin.qty, item.qty) : Math.max(1, Math.min(twin.qty + item.qty, Math.max(cap, 1)));
        await tx.update(cartItems).set({ qty }).where(eq(cartItems.id, twin.id));
        await tx.delete(cartItems).where(eq(cartItems.id, item.id));
      } else {
        const qty = patch.savedForLater || cap === 0 ? item.qty : Math.min(item.qty, cap);
        if (!patch.savedForLater && cap > 0 && qty < item.qty) message = `${sizeNote(cap)}, so we moved ${qty} to your bag`;
        await tx
          .update(cartItems)
          .set({ savedForLater: patch.savedForLater, qty, priceSeenPaise: row?.sku.pricePaise ?? item.priceSeenPaise })
          .where(eq(cartItems.id, item.id));
      }
    } else if (patch.qty !== undefined) {
      if (patch.qty > item.qty && cap === 0) throw new AppError('SKU_OUT_OF_STOCK', 'This size is out of stock');
      const qty = patch.qty > cap && cap > 0 ? cap : patch.qty;
      if (qty < patch.qty) message = `${sizeNote(cap)} in this size`;
      await tx.update(cartItems).set({ qty }).where(eq(cartItems.id, item.id));
    }
    await bumpVersion(tx, cart.id);
    return message;
  });
  return { cart: await buildCartDto(ctx, await reload(ctx, cart.id)), notice };
}

export async function removeItem(ctx: AppContext, cart: CartRow, itemId: string): Promise<CartMutationResponse> {
  await ctx.db.transaction(async (tx) => {
    const deleted = await tx
      .delete(cartItems)
      .where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cart.id)))
      .returning({ id: cartItems.id });
    if (deleted.length) await bumpVersion(tx, cart.id);
  });
  return { cart: await buildCartDto(ctx, await reload(ctx, cart.id)) };
}

/** Marks current prices as seen so "price changed" notices show once. */
export async function acknowledgePrices(ctx: AppContext, cart: CartRow): Promise<CartMutationResponse> {
  await ctx.db.execute(sql`
    UPDATE cart_items ci SET price_seen_paise = s.price_paise
    FROM skus s WHERE s.id = ci.sku_id AND ci.cart_id = ${cart.id} AND ci.price_seen_paise <> s.price_paise`);
  return { cart: await buildCartDto(ctx, await reload(ctx, cart.id)) };
}

async function reload(ctx: AppContext, cartId: string): Promise<CartRow> {
  return (await ctx.db.query.carts.findFirst({ where: eq(carts.id, cartId) }))!;
}

/**
 * Folds a guest bag into the user's bag on sign-in. Same SKU → the larger quantity (not the sum,
 * which would silently double items added on two devices), clamped to stock. Returns lines merged.
 */
export async function mergeGuestCart(ctx: AppContext, guestToken: string | undefined, userId: string): Promise<number> {
  if (!guestToken) return 0;
  return ctx.db.transaction(async (tx) => {
    const guest = await tx.query.carts.findFirst({
      where: and(eq(carts.guestTokenHash, sha256(guestToken)), eq(carts.status, 'active')),
    });
    if (!guest) return 0;
    const guestLines = await loadLines(tx, guest.id);
    await tx.update(carts).set({ status: 'merged' }).where(eq(carts.id, guest.id));
    if (guestLines.length === 0) return 0;

    let userCart = await tx.query.carts.findFirst({ where: and(eq(carts.userId, userId), eq(carts.status, 'active')) });
    if (!userCart) [userCart] = await tx.insert(carts).values({ userId }).returning();

    for (const line of guestLines) {
      const cap = capFor(line);
      const mine = await tx.query.cartItems.findFirst({
        where: and(eq(cartItems.cartId, userCart!.id), eq(cartItems.skuId, line.sku.id), eq(cartItems.savedForLater, line.item.savedForLater)),
      });
      if (mine) {
        const larger = Math.max(mine.qty, line.item.qty);
        await tx.update(cartItems).set({ qty: cap > 0 ? Math.min(larger, cap) : larger }).where(eq(cartItems.id, mine.id));
      } else {
        await tx.insert(cartItems).values({
          cartId: userCart!.id,
          skuId: line.sku.id,
          qty: cap > 0 ? Math.min(line.item.qty, cap) : line.item.qty,
          savedForLater: line.item.savedForLater,
          priceSeenPaise: line.item.priceSeenPaise,
        });
      }
    }
    await bumpVersion(tx, userCart!.id);
    return guestLines.length;
  });
}
