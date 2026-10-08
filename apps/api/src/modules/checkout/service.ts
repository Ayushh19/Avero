import type {
  ImageDto,
  CheckoutAddressInput,
  CheckoutSessionDto,
  CheckoutSessionPatch,
  QuoteDto,
  QuoteLineDto,
  ShippingMethod,
  StartCheckoutInput,
} from '@avero/shared';
import { and, asc, desc, eq, gt, inArray, isNull, type SQL } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import type { DbOrTx } from '../../db/client';
import {
  addresses,
  checkoutSessions,
  colorwayImages,
  orderEvents,
  orderItems,
  orders,
  type AddressSnapshot,
} from '../../db/schema';
import { enqueue } from '../../jobs/queue';
import { addMinutes } from '../../lib/clock';
import { randomCode, randomToken, sha256, stableStringify } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { capFor, loadLines, resolveCart, skuWithParents, type LineRow } from '../cart/service';
import { estimateDelivery, lookupPincode } from '../delivery/pincode';
import { reserveLines } from '../inventory/reservations';
import { pointsBalance, redeemPoints } from '../loyalty/points';
import { claimCoupon, normalizeCouponCode, validateCoupon, type CouponLineRef } from '../promotions/coupons';
import { personalCoupons } from '../referrals/service';
import { priceQuote, type PricingCoupon } from './pricing';

type SessionRow = typeof checkoutSessions.$inferSelect;
type CartRow = NonNullable<Awaited<ReturnType<typeof resolveCart>>>;
type OrderRow = typeof orders.$inferSelect;

/* ---------------- guest device token ---------------- */

/** Ties a guest's orders to this browser (httpOnly). Set when a guest starts checkout. */
export const GUEST_COOKIE = 'avero_guest';
const GUEST_COOKIE_DAYS = 90;

export function guestToken(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): string {
  const existing = req.cookies[GUEST_COOKIE];
  if (existing && /^[A-Za-z0-9_-]{20,}$/.test(existing)) return existing;
  const token = randomToken();
  reply.setCookie(GUEST_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.env.NODE_ENV === 'production',
    maxAge: GUEST_COOKIE_DAYS * 86_400,
  });
  // Visible to later handlers in this same request.
  req.cookies[GUEST_COOKIE] = token;
  return token;
}

/* ---------------- lines for checkout ---------------- */

/** What a session buys: the bag, or (buy now) one SKU on its own. Satisfied by a session row. */
interface LineSource {
  cartId: string;
  buyNowSkuId: string | null;
  buyNowQty: number | null;
}

interface CheckoutLine {
  row: Pick<LineRow, 'sku' | 'colorway' | 'product'>;
  /** Quantity that will be bought: requested qty clamped to what's purchasable now. */
  qty: number;
  image: ImageDto | null;
}

interface BlockedLine {
  skuId: string;
  reason: 'unavailable' | 'out_of_stock';
}

async function loadCheckoutLines(db: DbOrTx, source: LineSource): Promise<{ lines: CheckoutLine[]; blocked: BlockedLine[] }> {
  const wanted = source.buyNowSkuId
    ? [await skuWithParents(db, source.buyNowSkuId)].filter((r) => r !== undefined).map((row) => ({ row, qty: source.buyNowQty ?? 1 }))
    : (await loadLines(db, source.cartId)).filter((r) => !r.item.savedForLater).map((row) => ({ row, qty: row.item.qty }));
  const rows = wanted.map((w) => w.row);
  const images = rows.length
    ? await db
        .select()
        .from(colorwayImages)
        .where(and(inArray(colorwayImages.colorwayId, [...new Set(rows.map((r) => r.colorway.id))]), eq(colorwayImages.position, 0)))
    : [];
  const imageBy = new Map(images.map((i) => [i.colorwayId, { url: i.url, thumbUrl: i.thumbUrl, mediumUrl: i.mediumUrl, alt: i.alt }]));
  const lines: CheckoutLine[] = [];
  const blocked: BlockedLine[] = [];
  for (const { row, qty } of wanted) {
    const purchasable = row.product.status === 'active' && row.colorway.status === 'active' && row.sku.status === 'active';
    const cap = capFor(row);
    if (!purchasable) blocked.push({ skuId: row.sku.id, reason: 'unavailable' });
    else if (cap <= 0) blocked.push({ skuId: row.sku.id, reason: 'out_of_stock' });
    else lines.push({ row, qty: Math.min(qty, cap), image: imageBy.get(row.colorway.id) ?? null });
  }
  return { lines, blocked };
}

function assertCheckoutable(source: LineSource, lines: CheckoutLine[], blocked: BlockedLine[]): void {
  if (source.buyNowSkuId) {
    if (blocked.length || lines.length === 0) throw outOfStockFrom(source, blocked);
    return;
  }
  if (blocked.length) {
    throw new AppError('CART_NOT_READY', 'Some items in your bag are no longer available. Review your bag to continue.', { blocked });
  }
  if (lines.length === 0) throw new AppError('CART_NOT_READY', 'Your bag is empty');
}

/* ---------------- quote ---------------- */

interface Buyer {
  userId: string | null;
  email: string | null;
}

const couponRefs = (lines: CheckoutLine[]): CouponLineRef[] =>
  lines.map((l) => ({ skuId: l.row.sku.id, colorwayId: l.row.colorway.id, categoryId: l.row.product.categoryId }));

/** Resolves the session's coupon for pricing; an invalid coupon becomes `couponError` (not a throw). */
async function couponForQuote(ctx: AppContext, db: DbOrTx, code: string | null, buyer: Buyer, lines: CheckoutLine[]) {
  if (!code) return { pricing: null, eligible: null, error: null, description: '' };
  try {
    const v = await validateCoupon(ctx, db, code, buyer, couponRefs(lines));
    return { pricing: v.pricing, eligible: v.eligibleSkuIds, error: null, description: v.coupon.description };
  } catch (err) {
    if (err instanceof AppError && err.code.startsWith('COUPON_')) {
      return { pricing: null, eligible: null, error: { code: err.code, message: err.message }, description: '' };
    }
    throw err;
  }
}

function deliveryWindow(pincode: string, method: ShippingMethod, now: Date) {
  const info = lookupPincode(pincode);
  if (!info.serviceable) throw new AppError('PINCODE_NOT_SERVICEABLE', `We don’t deliver to ${pincode} yet`);
  const option = estimateDelivery(pincode, now).options.find((o) => o.method === method);
  if (!option) throw new AppError('SHIPPING_METHOD_UNAVAILABLE', `Express delivery isn’t available for ${pincode}`);
  return option;
}

/**
 * Prices the session from live data. Pure read: callers decide whether to persist it.
 * Throws if the bag can't be checked out or the address can't be served.
 */
async function computeQuote(
  ctx: AppContext,
  db: DbOrTx,
  session: SessionRow,
  lines: CheckoutLine[],
): Promise<QuoteDto> {
  if (!session.address || !session.email || !session.phone) {
    throw new AppError('VALIDATION_FAILED', 'Add your contact details and delivery address first');
  }
  const now = ctx.clock.now();
  const delivery = deliveryWindow(session.address.pincode, session.shippingMethod, now);
  const buyer: Buyer = { userId: session.userId, email: session.email };
  const coupon = await couponForQuote(ctx, db, session.couponCode, buyer, lines);
  const balance = session.userId ? await pointsBalance(db, session.userId) : 0;

  const priced = priceQuote({
    lines: lines.map((l) => ({
      skuId: l.row.sku.id,
      qty: l.qty,
      unitPricePaise: l.row.sku.pricePaise,
      gstRateBps: l.row.product.gstRateBps,
      couponEligible: coupon.eligible?.has(l.row.sku.id) ?? true,
    })),
    shippingMethod: session.shippingMethod,
    coupon: coupon.pricing,
    pointsRequested: session.pointsToRedeem,
    pointsBalance: balance,
    member: session.userId !== null,
  });

  const quoteLines: QuoteLineDto[] = lines.map((l, i) => {
    const p = priced.lines[i]!;
    return {
      skuId: l.row.sku.id,
      skuCode: l.row.sku.skuCode,
      productName: l.row.product.name,
      productSlug: l.row.product.slug,
      colorName: l.row.colorway.name,
      sizeLabel: l.row.sku.sizeLabel,
      href: `/p/${l.row.product.slug}/${l.row.colorway.slug}`,
      image: l.image,
      qty: l.qty,
      unitPricePaise: l.row.sku.pricePaise,
      mrpPaise: l.row.sku.mrpPaise,
      subtotalPaise: p.subtotalPaise,
      discountPaise: p.discountPaise,
      pointsDiscountPaise: p.pointsDiscountPaise,
      totalPaise: p.totalPaise,
      gstRateBps: l.row.product.gstRateBps,
      taxIncludedPaise: p.taxIncludedPaise,
    };
  });

  const couponApplied = priced.couponApplied && coupon.pricing;
  const body: Omit<QuoteDto, 'hash' | 'expiresAt'> = {
    lines: quoteLines,
    itemCount: lines.reduce((s, l) => s + l.qty, 0),
    subtotalPaise: priced.subtotalPaise,
    savingsPaise: lines.reduce((s, l) => s + (l.row.sku.mrpPaise - l.row.sku.pricePaise) * l.qty, 0),
    coupon: couponApplied ? { code: coupon.pricing!.code, description: coupon.description, kind: coupon.pricing!.kind } : null,
    couponError: coupon.error ?? priced.couponError,
    couponDiscountPaise: priced.couponDiscountPaise,
    shipping: {
      method: session.shippingMethod,
      feePaise: priced.shippingFeePaise,
      waivedPaise: priced.shippingWaivedPaise,
      earliest: delivery.earliest,
      latest: delivery.latest,
    },
    shippingPaise: priced.shippingPaise,
    points: { balance, maxRedeemable: priced.maxRedeemablePoints, redeemed: priced.pointsRedeemed },
    pointsDiscountPaise: priced.pointsDiscountPaise,
    totalPaise: priced.totalPaise,
    taxIncludedPaise: priced.taxIncludedPaise,
    pointsToEarn: priced.pointsToEarn,
  };
  return { ...body, hash: quoteHash(session, body), expiresAt: addMinutes(now, business.quoteTtlMinutes).toISOString() };
}

/**
 * What the shopper confirms. Covers every amount plus who/where it ships to, so any change to
 * prices, stock-clamped quantities, coupon, points, shipping or address produces a different hash.
 * (Points balance and delivery dates are informational and excluded.)
 */
function quoteHash(session: SessionRow, q: Omit<QuoteDto, 'hash' | 'expiresAt'>): string {
  return sha256(
    stableStringify({
      lines: q.lines.map((l) => [l.skuId, l.qty, l.unitPricePaise, l.discountPaise, l.pointsDiscountPaise, l.totalPaise]),
      subtotal: q.subtotalPaise,
      coupon: q.coupon?.code ?? null,
      couponDiscount: q.couponDiscountPaise,
      shipping: [q.shipping.method, q.shipping.feePaise, q.shipping.waivedPaise],
      points: q.points.redeemed,
      total: q.totalPaise,
      email: session.email,
      phone: session.phone,
      address: session.address,
    }),
  );
}

/** Human-readable differences between the quote the shopper saw and the current one. */
function diffQuotes(before: QuoteDto, after: QuoteDto) {
  const changes: Record<string, unknown>[] = [];
  const afterBy = new Map(after.lines.map((l) => [l.skuId, l]));
  for (const b of before.lines) {
    const a = afterBy.get(b.skuId);
    if (!a) changes.push({ type: 'line_removed', skuId: b.skuId, productName: b.productName });
    else {
      if (a.unitPricePaise !== b.unitPricePaise) {
        changes.push({ type: 'price', skuId: b.skuId, productName: b.productName, fromPaise: b.unitPricePaise, toPaise: a.unitPricePaise });
      }
      if (a.qty !== b.qty) changes.push({ type: 'qty', skuId: b.skuId, productName: b.productName, from: b.qty, to: a.qty });
    }
  }
  for (const a of after.lines) {
    if (!before.lines.some((b) => b.skuId === a.skuId)) changes.push({ type: 'line_added', skuId: a.skuId, productName: a.productName });
  }
  if ((before.coupon?.code ?? null) !== (after.coupon?.code ?? null) || before.couponDiscountPaise !== after.couponDiscountPaise) {
    changes.push({ type: 'coupon', fromPaise: before.couponDiscountPaise, toPaise: after.couponDiscountPaise, error: after.couponError });
  }
  if (before.shippingPaise !== after.shippingPaise) changes.push({ type: 'shipping', fromPaise: before.shippingPaise, toPaise: after.shippingPaise });
  if (before.points.redeemed !== after.points.redeemed) changes.push({ type: 'points', from: before.points.redeemed, to: after.points.redeemed });
  if (before.totalPaise !== after.totalPaise) changes.push({ type: 'total', fromPaise: before.totalPaise, toPaise: after.totalPaise });
  return changes;
}

/* ---------------- sessions ---------------- */

async function requireCart(ctx: AppContext, req: FastifyRequest): Promise<CartRow> {
  const cart = await resolveCart(ctx, req, null, false);
  if (!cart) throw new AppError('CART_NOT_READY', 'Your bag is empty');
  return cart;
}

async function loadSession(ctx: AppContext, req: FastifyRequest, sessionId: string): Promise<{ session: SessionRow; cart: CartRow }> {
  const cart = await requireCart(ctx, req);
  const session = await ctx.db.query.checkoutSessions.findFirst({
    where: and(eq(checkoutSessions.id, sessionId), eq(checkoutSessions.cartId, cart.id)),
  });
  if (!session) throw new AppError('NOT_FOUND', 'This checkout has ended. Please start again from your bag.');
  return { session, cart };
}

const LIVE_UNPAID = ['PENDING_PAYMENT', 'PAYMENT_FAILED'] as const;

/** Sessions that check out the same thing: the bag, or the same buy-now SKU. */
const sameSource = (source: LineSource): SQL =>
  source.buyNowSkuId
    ? and(eq(checkoutSessions.buyNowSkuId, source.buyNowSkuId), eq(checkoutSessions.buyNowQty, source.buyNowQty ?? 1))!
    : isNull(checkoutSessions.buyNowSkuId);

async function pendingOrderFor(ctx: AppContext, source: LineSource): Promise<CheckoutSessionDto['pendingOrder']> {
  const [row] = await ctx.db
    .select({ orderNumber: orders.orderNumber, totalPaise: orders.totalPaise, reservationExpiresAt: orders.reservationExpiresAt })
    .from(orders)
    .innerJoin(checkoutSessions, eq(checkoutSessions.id, orders.checkoutSessionId))
    .where(
      and(
        eq(checkoutSessions.cartId, source.cartId),
        source.buyNowSkuId ? eq(checkoutSessions.buyNowSkuId, source.buyNowSkuId) : isNull(checkoutSessions.buyNowSkuId),
        inArray(orders.status, [...LIVE_UNPAID]),
        gt(orders.reservationExpiresAt, ctx.clock.now()),
      ),
    )
    .orderBy(desc(orders.placedAt))
    .limit(1);
  return row ? { ...row, reservationExpiresAt: row.reservationExpiresAt!.toISOString() } : null;
}

async function toSessionDto(ctx: AppContext, session: SessionRow): Promise<CheckoutSessionDto> {
  const now = ctx.clock.now();
  const quote = session.quote && session.quoteExpiresAt && session.quoteExpiresAt > now ? (session.quote as QuoteDto) : null;
  const shippingOptions = session.address
    ? estimateDelivery(session.address.pincode, now).options.map((o) => ({
        method: o.method as ShippingMethod,
        label: o.label,
        feePaise: o.feePaise,
        earliest: o.earliest,
        latest: o.latest,
      }))
    : [];
  const { lines } = await loadCheckoutLines(ctx.db, session);
  const items = lines.map((l) => ({
    skuId: l.row.sku.id,
    productName: l.row.product.name,
    colorName: l.row.colorway.name,
    sizeLabel: l.row.sku.sizeLabel,
    image: l.image,
    qty: l.qty,
    totalPaise: l.row.sku.pricePaise * l.qty,
  }));
  return {
    id: session.id,
    status: session.status,
    mode: session.buyNowSkuId ? 'buy_now' : 'bag',
    items,
    subtotalPaise: items.reduce((s, i) => s + i.totalPaise, 0),
    isGuest: session.userId === null,
    email: session.email,
    phone: session.phone,
    address: session.address ? toAddressInput(session.address) : null,
    shippingMethod: session.shippingMethod,
    shippingOptions,
    couponCode: session.couponCode,
    pointsToRedeem: session.pointsToRedeem,
    quote,
    ready: Boolean(session.email && session.phone && session.address),
    pendingOrder: await pendingOrderFor(ctx, session),
    personalCoupons: session.userId
      ? (await personalCoupons(ctx.db, session.userId, now)).map(({ code, description }) => ({ code, description }))
      : [],
  };
}

function toAddressInput(a: AddressSnapshot): CheckoutAddressInput {
  return {
    fullName: a.fullName,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2 ?? undefined,
    landmark: a.landmark ?? undefined,
    city: a.city,
    state: a.state as CheckoutAddressInput['state'],
    pincode: a.pincode,
  };
}

/**
 * Creates (or resumes) the open checkout session for the shopper's bag, or — with `buyNow` — for
 * that one item alone (the bag is neither read nor trimmed). Members get contact details and their
 * default address prefilled.
 */
export async function startSession(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  input: StartCheckoutInput = {},
): Promise<CheckoutSessionDto> {
  // Buy now still anchors the session to the shopper's bag (that's what proves ownership later).
  const cart = input.buyNow ? (await resolveCart(ctx, req, reply, true))! : await requireCart(ctx, req);
  const source: LineSource = { cartId: cart.id, buyNowSkuId: input.buyNow?.skuId ?? null, buyNowQty: input.buyNow?.qty ?? null };
  const { lines, blocked } = await loadCheckoutLines(ctx.db, source);
  assertCheckoutable(source, lines, blocked);
  if (!req.user) guestToken(ctx, req, reply);

  const existing = await ctx.db.query.checkoutSessions.findFirst({
    where: and(eq(checkoutSessions.cartId, cart.id), eq(checkoutSessions.status, 'open'), sameSource(source)),
    orderBy: desc(checkoutSessions.createdAt),
  });
  if (existing) return toSessionDto(ctx, existing);

  // Starting again from the same bag (e.g. after an order expired, or a buy-now): keep what was already entered.
  const previous = await ctx.db.query.checkoutSessions.findFirst({
    where: eq(checkoutSessions.cartId, cart.id),
    orderBy: desc(checkoutSessions.createdAt),
  });
  if (previous && previous.userId === (req.user?.id ?? null)) {
    const [copied] = await ctx.db
      .insert(checkoutSessions)
      .values({
        cartId: cart.id,
        buyNowSkuId: source.buyNowSkuId,
        buyNowQty: source.buyNowQty,
        userId: previous.userId,
        email: previous.email,
        phone: previous.phone,
        address: previous.address,
        shippingMethod: previous.shippingMethod,
      })
      .returning();
    return toSessionDto(ctx, copied!);
  }

  let address: AddressSnapshot | null = null;
  if (req.user) {
    const saved = await ctx.db.query.addresses.findMany({
      where: eq(addresses.userId, req.user.id),
      orderBy: [desc(addresses.isDefault), asc(addresses.createdAt)],
    });
    const usable = saved.find((a) => lookupPincode(a.pincode).serviceable);
    if (usable) address = snapshotOf(usable);
  }
  const [created] = await ctx.db
    .insert(checkoutSessions)
    .values({
      cartId: cart.id,
      buyNowSkuId: source.buyNowSkuId,
      buyNowQty: source.buyNowQty,
      userId: req.user?.id ?? null,
      email: req.user?.email ?? null,
      phone: req.user?.phone ?? address?.phone ?? null,
      address,
    })
    .returning();
  return toSessionDto(ctx, created!);
}

export async function getSession(ctx: AppContext, req: FastifyRequest, sessionId: string): Promise<CheckoutSessionDto> {
  return toSessionDto(ctx, (await loadSession(ctx, req, sessionId)).session);
}

function snapshotOf(a: typeof addresses.$inferSelect): AddressSnapshot {
  return {
    fullName: a.fullName,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    landmark: a.landmark,
    city: a.city,
    state: a.state,
    pincode: a.pincode,
  };
}

const MAX_SAVED_ADDRESSES = 20;

/** Contact / address / delivery / coupon / points. Any change clears the current quote. */
export async function patchSession(
  ctx: AppContext,
  req: FastifyRequest,
  sessionId: string,
  patch: CheckoutSessionPatch,
): Promise<CheckoutSessionDto> {
  const { session } = await loadSession(ctx, req, sessionId);
  if (session.status !== 'open') throw new AppError('CONFLICT', 'An order has already been placed from this checkout');
  const user = req.user;
  const set: Partial<typeof checkoutSessions.$inferInsert> = {};

  if (patch.email !== undefined) {
    if (user && patch.email !== user.email) {
      throw new AppError('VALIDATION_FAILED', 'Order updates go to your account email. Change it in your profile.');
    }
    set.email = patch.email;
  }
  if (patch.phone !== undefined) set.phone = patch.phone;

  let address = session.address;
  if (patch.addressId) {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in to use a saved address');
    const saved = await ctx.db.query.addresses.findFirst({ where: and(eq(addresses.id, patch.addressId), eq(addresses.userId, user.id)) });
    if (!saved) throw new AppError('NOT_FOUND', 'Address not found');
    address = snapshotOf(saved);
  } else if (patch.address) {
    address = { ...patch.address, line2: patch.address.line2 ?? null, landmark: patch.address.landmark ?? null };
  }
  if (address !== session.address && address) {
    const info = lookupPincode(address.pincode);
    if (!info.serviceable) throw new AppError('PINCODE_NOT_SERVICEABLE', `We don’t deliver to ${address.pincode} yet`);
    set.address = address;
    if (!set.phone && !session.phone) set.phone = address.phone;
    // Express may not reach the new PIN: fall back to standard rather than fail.
    if (session.shippingMethod === 'express' && !info.express && patch.shippingMethod !== 'express') set.shippingMethod = 'standard';
    if (patch.address && patch.saveAddress && user) await saveToAddressBook(ctx, user.id, address);
  }

  if (patch.shippingMethod) {
    if (patch.shippingMethod === 'express') {
      if (!address) throw new AppError('VALIDATION_FAILED', 'Add a delivery address first');
      if (!lookupPincode(address.pincode).express) {
        throw new AppError('SHIPPING_METHOD_UNAVAILABLE', `Express delivery isn’t available for ${address.pincode}`);
      }
    }
    set.shippingMethod = patch.shippingMethod;
  }

  if (patch.pointsToRedeem !== undefined) {
    if (patch.pointsToRedeem > 0) {
      if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in to use your points');
      const balance = await pointsBalance(ctx.db, user.id);
      if (patch.pointsToRedeem > balance) {
        throw new AppError('POINTS_INSUFFICIENT', `You have ${balance} points available`, { balance });
      }
    }
    set.pointsToRedeem = patch.pointsToRedeem;
  }

  if (patch.couponCode !== undefined) {
    if (patch.couponCode === null) set.couponCode = null;
    else {
      // Reject a coupon that can't apply right now, with the precise reason.
      const { lines, blocked } = await loadCheckoutLines(ctx.db, session);
      assertCheckoutable(session, lines, blocked);
      const email = set.email ?? session.email;
      const v = await validateCoupon(ctx, ctx.db, patch.couponCode, { userId: session.userId, email }, couponRefs(lines));
      const trial = priceQuote({
        lines: lines.map((l) => ({
          skuId: l.row.sku.id,
          qty: l.qty,
          unitPricePaise: l.row.sku.pricePaise,
          gstRateBps: l.row.product.gstRateBps,
          couponEligible: v.eligibleSkuIds.has(l.row.sku.id),
        })),
        shippingMethod: set.shippingMethod ?? session.shippingMethod,
        coupon: v.pricing as PricingCoupon,
        pointsRequested: 0,
        pointsBalance: 0,
        member: false,
      });
      if (trial.couponError) throw new AppError(trial.couponError.code, trial.couponError.message);
      set.couponCode = normalizeCouponCode(patch.couponCode);
    }
  }

  const [updated] = await ctx.db
    .update(checkoutSessions)
    .set({ ...set, quote: null, quoteHash: null, quoteExpiresAt: null })
    .where(eq(checkoutSessions.id, session.id))
    .returning();
  return toSessionDto(ctx, updated!);
}

async function saveToAddressBook(ctx: AppContext, userId: string, a: AddressSnapshot): Promise<void> {
  const existing = await ctx.db.query.addresses.findMany({ where: eq(addresses.userId, userId) });
  if (existing.length >= MAX_SAVED_ADDRESSES) return;
  const duplicate = existing.some((e) => e.line1 === a.line1 && e.pincode === a.pincode && e.fullName === a.fullName);
  if (duplicate) return;
  await ctx.db.insert(addresses).values({ userId, ...a, isDefault: existing.length === 0 });
}

/** Computes, stores and returns the final quote the shopper confirms (valid 10 minutes). */
export async function quoteSession(ctx: AppContext, req: FastifyRequest, sessionId: string): Promise<QuoteDto> {
  const { session } = await loadSession(ctx, req, sessionId);
  if (session.status !== 'open') throw new AppError('CONFLICT', 'An order has already been placed from this checkout');
  const { lines, blocked } = await loadCheckoutLines(ctx.db, session);
  assertCheckoutable(session, lines, blocked);
  const quote = await computeQuote(ctx, ctx.db, session, lines);
  await storeQuote(ctx.db, session.id, quote);
  return quote;
}

async function storeQuote(db: DbOrTx, sessionId: string, quote: QuoteDto): Promise<void> {
  await db
    .update(checkoutSessions)
    .set({ quote, quoteHash: quote.hash, quoteExpiresAt: new Date(quote.expiresAt) })
    .where(eq(checkoutSessions.id, sessionId));
}

/* ---------------- place order ---------------- */

export function orderNumber(now: Date): string {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const yymm = `${String(ist.getUTCFullYear()).slice(2)}${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
  return `AV-${yymm}-${randomCode(5)}`;
}

function outOfStockFrom(source: LineSource, blocked: BlockedLine[]): AppError {
  const unavailable = blocked.length > 0 && blocked.every((b) => b.reason === 'unavailable');
  const where = source.buyNowSkuId ? 'This item' : 'Some items in your bag';
  return new AppError(
    unavailable ? 'SKU_UNAVAILABLE' : 'SKU_OUT_OF_STOCK',
    unavailable ? `${where} ${source.buyNowSkuId ? 'is' : 'are'} no longer available` : `${where} just sold out`,
    { blocked },
  );
}

/**
 * Validates the quote the shopper confirmed against live data and, if it still holds, creates the
 * order in one transaction: stock reserved, coupon redeemed, points redeemed, items snapshotted,
 * expiry job enqueued. Stale or changed quotes are rejected before anything is reserved.
 */
export async function placeOrder(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  input: { sessionId: string; quoteHash: string },
): Promise<OrderRow> {
  const { session } = await loadSession(ctx, req, input.sessionId);
  const guestHash = req.user ? null : sha256(guestToken(ctx, req, reply));

  // ---- 1. Check the confirmed quote against live data (outside the transaction so a fresh
  //         quote can be stored and returned to the shopper).
  if (session.status === 'order_placed') {
    const placed = await ctx.db.query.orders.findFirst({ where: eq(orders.checkoutSessionId, session.id) });
    throw new AppError('CONFLICT', 'An order has already been placed from this checkout', { orderNumber: placed?.orderNumber });
  }
  if (session.status !== 'open') throw new AppError('NOT_FOUND', 'This checkout has ended. Please start again from your bag.');

  const { lines, blocked } = await loadCheckoutLines(ctx.db, session);
  if (blocked.length) throw outOfStockFrom(session, blocked);
  if (lines.length === 0) throw new AppError('CART_NOT_READY', 'Your bag is empty');

  const confirmed = session.quote as QuoteDto | null;
  const fresh = await computeQuote(ctx, ctx.db, session, lines);
  const reject = async (code: 'QUOTE_CHANGED' | 'QUOTE_EXPIRED', message: string, extra: Record<string, unknown> = {}) => {
    await storeQuote(ctx.db, session.id, fresh);
    return new AppError(code, message, { quote: fresh, ...extra });
  };

  if (!confirmed || session.quoteHash !== input.quoteHash) {
    throw await reject('QUOTE_CHANGED', 'Your order summary was updated. Please review it before paying.', {
      changes: confirmed ? diffQuotes(confirmed, fresh) : [],
    });
  }
  // Fewer units purchasable than confirmed → it's a stock-out, not just a re-price.
  const freshQty = new Map(fresh.lines.map((l) => [l.skuId, l.qty]));
  const short = confirmed.lines.filter((l) => (freshQty.get(l.skuId) ?? 0) < l.qty);
  if (short.length) {
    await storeQuote(ctx.db, session.id, fresh);
    throw new AppError('SKU_OUT_OF_STOCK', short.length === 1 ? `${short[0]!.productName} in size ${short[0]!.sizeLabel} just sold out` : 'Some items in your bag just sold out', {
      lines: short.map((l) => ({ skuId: l.skuId, requested: l.qty, available: freshQty.get(l.skuId) ?? 0 })),
      quote: fresh,
    });
  }
  // A coupon that was applied and has since become invalid keeps its precise code.
  if (confirmed.coupon && !fresh.coupon && fresh.couponError) {
    await storeQuote(ctx.db, session.id, fresh);
    throw new AppError(fresh.couponError.code, fresh.couponError.message, { quote: fresh });
  }
  if (fresh.hash !== confirmed.hash) {
    throw await reject('QUOTE_CHANGED', 'Prices or offers changed since you reviewed your order.', {
      changes: diffQuotes(confirmed, fresh),
    });
  }
  if (!session.quoteExpiresAt || session.quoteExpiresAt <= ctx.clock.now()) {
    throw await reject('QUOTE_EXPIRED', 'Your order summary expired. Please review it again.');
  }

  // ---- 2. Create the order atomically.
  const order = await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, session.id)).for('update');
    if (!locked || locked.status !== 'open' || locked.quoteHash !== input.quoteHash) {
      throw new AppError('CONFLICT', 'This checkout changed while placing your order. Please review it again.');
    }
    // Re-price inside the transaction: anything that moved since step 1 shows up as a hash change.
    const txLines = await loadCheckoutLines(tx, locked);
    if (txLines.blocked.length) throw outOfStockFrom(locked, txLines.blocked);
    const check = await computeQuote(ctx, tx, locked, txLines.lines);
    if (check.hash !== input.quoteHash) {
      throw new AppError('QUOTE_CHANGED', 'Prices or offers changed while placing your order. Please review it again.', {
        quote: check,
        changes: diffQuotes(confirmed, check),
      });
    }

    const now = ctx.clock.now();
    const reservationExpiresAt = addMinutes(now, business.reservationTtlMinutes);
    const orderId = uuidv7();
    let number = orderNumber(now);
    while (await tx.query.orders.findFirst({ where: eq(orders.orderNumber, number), columns: { id: true } })) number = orderNumber(now);

    const [created] = await tx
      .insert(orders)
      .values({
        id: orderId,
        orderNumber: number,
        userId: locked.userId,
        checkoutSessionId: locked.id,
        email: locked.email!,
        phone: locked.phone!,
        status: 'PENDING_PAYMENT',
        address: locked.address!,
        shippingMethod: locked.shippingMethod,
        subtotalPaise: check.subtotalPaise,
        discountPaise: check.couponDiscountPaise,
        shippingPaise: check.shippingPaise,
        pointsDiscountPaise: check.pointsDiscountPaise,
        pointsRedeemed: check.points.redeemed,
        totalPaise: check.totalPaise,
        taxPaise: check.taxIncludedPaise,
        couponCode: check.coupon?.code ?? null,
        guestTokenHash: locked.userId ? null : guestHash,
        reservationExpiresAt,
        placedAt: now,
      })
      .returning();

    const byId = new Map(txLines.lines.map((l) => [l.row.sku.id, l]));
    await tx.insert(orderItems).values(
      check.lines.map((q) => {
        const l = byId.get(q.skuId)!;
        return {
          orderId,
          skuId: q.skuId,
          productId: l.row.product.id,
          productName: l.row.product.name,
          productSlug: l.row.product.slug,
          colorwayId: l.row.colorway.id,
          colorwayName: l.row.colorway.name,
          colorwaySlug: l.row.colorway.slug,
          sizeLabel: l.row.sku.sizeLabel,
          skuCode: l.row.sku.skuCode,
          imageUrl: l.image?.thumbUrl ?? l.image?.url ?? null,
          isFinalSale: l.row.product.isFinalSale,
          unitPricePaise: q.unitPricePaise,
          mrpPaise: q.mrpPaise,
          qty: q.qty,
          discountPaise: q.discountPaise,
          pointsDiscountPaise: q.pointsDiscountPaise,
          totalPaise: q.totalPaise,
          gstRateBps: q.gstRateBps,
        };
      }),
    );

    await reserveLines(
      tx,
      orderId,
      check.lines.map((q) => ({ skuId: q.skuId, qty: q.qty, sizeLabel: q.sizeLabel, productName: q.productName })),
      reservationExpiresAt,
    );
    if (check.coupon) {
      await claimCoupon(ctx, tx, check.coupon.code, { id: orderId, userId: locked.userId, email: locked.email! }, couponRefs(txLines.lines));
    }
    if (check.points.redeemed > 0) await redeemPoints(ctx, tx, locked.userId!, orderId, check.points.redeemed);

    await tx.insert(orderEvents).values({
      orderId,
      type: 'order_placed',
      toStatus: 'PENDING_PAYMENT',
      meta: { quoteHash: check.hash },
      occurredAt: now,
    });
    await tx.update(checkoutSessions).set({ status: 'order_placed' }).where(eq(checkoutSessions.id, locked.id));
    await enqueue(tx, 'reservation.expire', { orderId }, { runAt: reservationExpiresAt, dedupeKey: `reservation-expire:${orderId}` });
    return created!;
  });

  ctx.catalog.invalidate();
  return order;
}
