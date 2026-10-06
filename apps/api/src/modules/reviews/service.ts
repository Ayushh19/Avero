import type { MyReviewDto, ReviewDto, ReviewListDto, ReviewableItemDto, ReviewFit } from '@avero/shared';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import type { Tx } from '../../db/client';
import { colorways, orderItems, orders, pointsLedger, products, reviewVotes, reviews, users } from '../../db/schema';
import { noticeTemplate } from '../../lib/email-templates';
import { AppError } from '../../lib/errors';
import { lotExpiry, schedulePointsExpiry } from '../loyalty/lifecycle';
import { notify } from '../notifications/service';

/**
 * Verified reviews (docs/BUSINESS_RULES.md 29–30). A member may review a product once they hold a
 * DELIVERED (not returned) order line of it; one review per product per member, editable by the
 * author. The product's rating aggregates are recomputed in the same transaction as every change.
 * First review of a product earns `business.points.reviewBonus` available points (once per product,
 * never clawed back).
 */

const PAGE = 10;
type ReviewRow = typeof reviews.$inferSelect;

const authorName = (full: string) => {
  const [first, ...rest] = full.trim().split(/\s+/);
  const last = rest.at(-1);
  return last ? `${first} ${last[0]!.toUpperCase()}.` : (first ?? 'AVERO customer');
};

/** Order lines this member could review now, newest first, one per product. */
export async function reviewableItems(ctx: AppContext, userId: string): Promise<ReviewableItemDto[]> {
  const reviewed = (await ctx.db.select({ productId: reviews.productId }).from(reviews).where(eq(reviews.userId, userId))).map((r) => r.productId);
  const rows = await ctx.db
    .select({ item: orderItems, orderNumber: orders.orderNumber, deliveredAt: orders.deliveredAt })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orders.userId, userId),
        eq(orderItems.status, 'DELIVERED'),
        reviewed.length ? notInArray(orderItems.productId, reviewed) : undefined,
      ),
    )
    .orderBy(desc(orders.deliveredAt));
  const seen = new Set<string>();
  return rows
    .filter((r) => (seen.has(r.item.productId) ? false : (seen.add(r.item.productId), true)))
    .map((r) => ({
      orderItemId: r.item.id,
      orderNumber: r.orderNumber,
      productName: r.item.productName,
      productSlug: r.item.productSlug,
      colorName: r.item.colorwayName,
      sizeLabel: r.item.sizeLabel,
      imageUrl: r.item.imageUrl,
      href: `/p/${r.item.productSlug}/${r.item.colorwaySlug}`,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
    }));
}

/** Rating average, count and fit tallies from published reviews. */
export async function recomputeAggregates(tx: Tx, productId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE products p SET
      rating_avg = coalesce(a.avg, 0),
      rating_count = a.count,
      fit_small_count = a.small,
      fit_true_count = a.true_fit,
      fit_large_count = a.large
    FROM (
      SELECT round(avg(rating)::numeric, 2) AS avg, count(*)::int AS count,
        count(*) FILTER (WHERE fit = 'small')::int AS small,
        count(*) FILTER (WHERE fit = 'true')::int AS true_fit,
        count(*) FILTER (WHERE fit = 'large')::int AS large
      FROM reviews WHERE product_id = ${productId} AND status = 'published'
    ) a
    WHERE p.id = ${productId}`);
}

export async function createReview(
  ctx: AppContext,
  userId: string,
  input: { orderItemId: string; rating: number; title: string; body: string; fit?: ReviewFit | null },
): Promise<ReviewRow> {
  const review = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ item: orderItems, order: orders })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(eq(orderItems.id, input.orderItemId));
    if (!row || row.order.userId !== userId || row.item.status !== 'DELIVERED') {
      throw new AppError('REVIEW_NOT_ELIGIBLE', 'You can review products you’ve received and kept');
    }
    const existing = await tx.query.reviews.findFirst({ where: and(eq(reviews.userId, userId), eq(reviews.productId, row.item.productId)) });
    if (existing) throw new AppError('CONFLICT', 'You’ve already reviewed this product — you can edit your review instead', { reviewId: existing.id });

    const now = ctx.clock.now();
    const [created] = await tx
      .insert(reviews)
      .values({
        productId: row.item.productId,
        colorwayId: row.item.colorwayId,
        userId,
        orderItemId: row.item.id,
        rating: input.rating,
        title: input.title,
        body: input.body,
        fit: input.fit ?? null,
        sizePurchased: row.item.sizeLabel,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await recomputeAggregates(tx, row.item.productId);

    // Once per product, even if a review is deleted and written again.
    const note = `Review bonus · ${row.item.productName}`;
    const bonusKey = `review:${row.item.productId}`;
    const already = await tx.query.pointsLedger.findFirst({
      where: and(eq(pointsLedger.userId, userId), eq(pointsLedger.kind, 'bonus'), sql`${pointsLedger.note} LIKE ${`%[${bonusKey}]`}`),
    });
    if (!already) {
      await tx.insert(pointsLedger).values({
        userId,
        delta: business.points.reviewBonus,
        kind: 'bonus',
        status: 'available',
        note: `${note} [${bonusKey}]`,
        availableAt: now,
        expiresAt: lotExpiry(now),
        createdAt: now,
      });
      await schedulePointsExpiry(tx, userId, lotExpiry(now));
      await notify(ctx, tx, {
        userId,
        kind: 'points',
        title: `+${business.points.reviewBonus} points for your review`,
        body: `Thanks for reviewing ${row.item.productName}.`,
        link: '/account/rewards',
      });
    }
    return created!;
  });
  ctx.catalog.invalidate();
  return review;
}

async function ownReview(tx: Tx, userId: string, id: string): Promise<ReviewRow> {
  const [row] = await tx.select().from(reviews).where(eq(reviews.id, id)).for('update');
  if (!row || row.userId !== userId) throw new AppError('NOT_FOUND', 'Review not found');
  return row;
}

export async function updateReview(
  ctx: AppContext,
  userId: string,
  id: string,
  patch: { rating?: number; title?: string; body?: string; fit?: ReviewFit | null },
): Promise<ReviewRow> {
  const updated = await ctx.db.transaction(async (tx) => {
    const row = await ownReview(tx, userId, id);
    const [next] = await tx
      .update(reviews)
      .set({ ...patch, updatedAt: ctx.clock.now() })
      .where(eq(reviews.id, row.id))
      .returning();
    await recomputeAggregates(tx, row.productId);
    return next!;
  });
  ctx.catalog.invalidate();
  return updated;
}

export async function deleteReview(ctx: AppContext, userId: string, id: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const row = await ownReview(tx, userId, id);
    await tx.delete(reviews).where(eq(reviews.id, row.id));
    await recomputeAggregates(tx, row.productId);
  });
  ctx.catalog.invalidate();
}

/** Helpful votes: one per member per review, never on your own. Idempotent both ways. */
export async function setHelpful(ctx: AppContext, userId: string, id: string, on: boolean): Promise<{ helpfulCount: number; votedHelpful: boolean }> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(reviews).where(and(eq(reviews.id, id), eq(reviews.status, 'published'))).for('update');
    if (!row) throw new AppError('NOT_FOUND', 'Review not found');
    if (row.userId === userId) throw new AppError('FORBIDDEN', 'You can’t vote on your own review');
    const changed = on
      ? await tx.insert(reviewVotes).values({ reviewId: id, userId }).onConflictDoNothing().returning()
      : await tx.delete(reviewVotes).where(and(eq(reviewVotes.reviewId, id), eq(reviewVotes.userId, userId))).returning();
    let count = row.helpfulCount;
    if (changed.length) {
      count += on ? 1 : -1;
      await tx.update(reviews).set({ helpfulCount: count }).where(eq(reviews.id, id));
    }
    return { helpfulCount: count, votedHelpful: on };
  });
}

/* ---------------- reads ---------------- */

async function toDtos(ctx: AppContext, rows: ReviewRow[], viewerId: string | null): Promise<ReviewDto[]> {
  if (rows.length === 0) return [];
  const authorRows = await ctx.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.userId))]));
  const colorRows = await ctx.db.select({ id: colorways.id, name: colorways.name }).from(colorways).where(inArray(colorways.id, [...new Set(rows.map((r) => r.colorwayId))]));
  const voted = viewerId
    ? new Set(
        (await ctx.db.select({ id: reviewVotes.reviewId }).from(reviewVotes).where(and(eq(reviewVotes.userId, viewerId), inArray(reviewVotes.reviewId, rows.map((r) => r.id))))).map((v) => v.id),
      )
    : new Set<string>();
  const author = new Map(authorRows.map((a) => [a.id, a.name]));
  const color = new Map(colorRows.map((c) => [c.id, c.name]));
  return rows.map((r) => ({
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    fit: r.fit,
    sizePurchased: r.sizePurchased,
    colorName: color.get(r.colorwayId) ?? '',
    authorName: authorName(author.get(r.userId) ?? ''),
    verified: true,
    helpfulCount: r.helpfulCount,
    votedHelpful: voted.has(r.id),
    mine: r.userId === viewerId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function listProductReviews(
  ctx: AppContext,
  productSlug: string,
  query: { sort: 'recent' | 'helpful' | 'rating_high' | 'rating_low'; rating?: number; page: number },
  viewerId: string | null,
): Promise<ReviewListDto> {
  const product = await ctx.db.query.products.findFirst({ where: eq(products.slug, productSlug) });
  if (!product) throw new AppError('NOT_FOUND', 'Product not found');
  const base = and(eq(reviews.productId, product.id), eq(reviews.status, 'published'));
  const where = and(base, query.rating ? eq(reviews.rating, query.rating) : undefined);
  const order = {
    recent: [desc(reviews.createdAt)],
    helpful: [desc(reviews.helpfulCount), desc(reviews.createdAt)],
    rating_high: [desc(reviews.rating), desc(reviews.createdAt)],
    rating_low: [asc(reviews.rating), desc(reviews.createdAt)],
  }[query.sort];

  const [{ total }] = (await ctx.db.select({ total: sql<number>`count(*)::int` }).from(reviews).where(where)) as [{ total: number }];
  const rows = await ctx.db.select().from(reviews).where(where).orderBy(...order).limit(PAGE).offset((query.page - 1) * PAGE);
  const dist = await ctx.db.select({ rating: reviews.rating, n: sql<number>`count(*)::int` }).from(reviews).where(base).groupBy(reviews.rating);
  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const d of dist) distribution[d.rating - 1] = d.n;

  let canReview: ReviewListDto['canReview'] = null;
  let myReviewId: string | null = null;
  if (viewerId) {
    const mine = await ctx.db.query.reviews.findFirst({ where: and(eq(reviews.userId, viewerId), eq(reviews.productId, product.id)) });
    myReviewId = mine?.id ?? null;
    if (!mine) {
      const item = (await reviewableItems(ctx, viewerId)).find((i) => i.productSlug === product.slug);
      canReview = item ? { orderItemId: item.orderItemId } : null;
    }
  }

  return {
    summary: {
      average: Number(product.ratingAvg),
      count: product.ratingCount,
      distribution,
      fit: { small: product.fitSmallCount, true: product.fitTrueCount, large: product.fitLargeCount },
    },
    reviews: await toDtos(ctx, rows, viewerId),
    page: query.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE)),
    canReview,
    myReviewId,
  };
}

export async function myReviews(ctx: AppContext, userId: string): Promise<MyReviewDto[]> {
  const rows = await ctx.db.query.reviews.findMany({ where: eq(reviews.userId, userId), orderBy: desc(reviews.createdAt) });
  const dtos = await toDtos(ctx, rows, userId);
  const items = rows.length ? await ctx.db.query.orderItems.findMany({ where: inArray(orderItems.id, rows.map((r) => r.orderItemId)) }) : [];
  return dtos.map((d, i) => {
    const item = items.find((x) => x.id === rows[i]!.orderItemId)!;
    return { ...d, productName: item.productName, productSlug: item.productSlug, href: `/p/${item.productSlug}/${item.colorwaySlug}`, imageUrl: item.imageUrl };
  });
}

/* ---------------- review prompt ---------------- */

/** Job `review.prompt`: a few days after delivery, nudge members about lines they haven't reviewed. */
export async function sendReviewPrompt(ctx: AppContext, orderId: string): Promise<void> {
  const order = await ctx.db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order?.userId) return;
  const pending = (await reviewableItems(ctx, order.userId)).filter((i) => i.orderNumber === order.orderNumber);
  if (pending.length === 0) return;
  const first = pending[0]!;
  await ctx.db.transaction(async (tx) => {
    await notify(ctx, tx, {
      userId: order.userId,
      kind: 'review_prompt',
      title: `How are your ${first.productName}?`,
      body: `Share a quick review and get ${business.points.reviewBonus} points.`,
      link: `/account/reviews/new/${first.orderItemId}`,
      email: noticeTemplate({
        to: order.email,
        template: 'review_prompt',
        subject: `How are your ${first.productName}?`,
        heading: 'Tell us what you think',
        paragraphs: [
          `Your order ${order.orderNumber} arrived a few days ago. A short review helps other shoppers choose the right pair — and earns you ${business.points.reviewBonus} AVERO points.`,
        ],
        link: { href: `${ctx.env.WEB_ORIGIN}/account/reviews/new/${first.orderItemId}`, label: 'Write a review' },
      }),
    });
  });
}
