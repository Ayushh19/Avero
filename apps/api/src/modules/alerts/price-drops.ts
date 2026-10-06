import { formatINR } from '@avero/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { DbOrTx, Tx } from '../../db/client';
import { colorways, products, skus, stockAlerts, users, wishlistItems } from '../../db/schema';
import { enqueue } from '../../jobs/queue';
import { noticeTemplate } from '../../lib/email-templates';
import { AppError } from '../../lib/errors';
import { notify } from '../notifications/service';

/**
 * Price-drop alerts. Two sources, one job:
 * - explicit "Tell me if the price drops" (stock_alerts kind price_drop, members or guest email),
 *   baseline = the lowest price when asked; notified once.
 * - members' wishlist items: notified each time the price reaches a new low below the price when
 *   added (`wishlist_items.price_alerted_paise` remembers the last alerted price).
 * Triggered by `price_drop.check` whenever a SKU price goes down (dev panel, catalog reprice).
 */

/** Lowest price among a colourway's purchasable sizes. */
export async function lowestPrice(db: DbOrTx, colorwayId: string): Promise<number | null> {
  const [row] = await db
    .select({ price: sql<number | null>`min(${skus.pricePaise})` })
    .from(skus)
    .where(and(eq(skus.colorwayId, colorwayId), eq(skus.status, 'active')));
  return row?.price ? Number(row.price) : null;
}

/** Call in the transaction that lowers a price. */
export async function enqueuePriceDropCheck(tx: Tx, colorwayId: string): Promise<void> {
  await enqueue(tx, 'price_drop.check', { colorwayId }, { dedupeKey: `price-drop:${colorwayId}` });
}

export async function createPriceAlert(ctx: AppContext, input: { colorwayId: string; email: string; userId: string | null }): Promise<{ baselinePricePaise: number }> {
  const baseline = await lowestPrice(ctx.db, input.colorwayId);
  if (baseline === null) throw new AppError('NOT_FOUND', 'This product isn’t available');
  const existing = await ctx.db.query.stockAlerts.findFirst({
    where: and(eq(stockAlerts.colorwayId, input.colorwayId), eq(stockAlerts.email, input.email), eq(stockAlerts.kind, 'price_drop'), isNull(stockAlerts.notifiedAt)),
  });
  if (existing) return { baselinePricePaise: existing.baselinePricePaise ?? baseline };
  await ctx.db.insert(stockAlerts).values({ userId: input.userId, email: input.email, kind: 'price_drop', colorwayId: input.colorwayId, baselinePricePaise: baseline });
  return { baselinePricePaise: baseline };
}

/** Job `price_drop.check`. */
export async function checkPriceDrop(ctx: AppContext, colorwayId: string): Promise<number> {
  const current = await lowestPrice(ctx.db, colorwayId);
  if (current === null) return 0;
  const [cw] = await ctx.db
    .select({ colorway: colorways, product: products })
    .from(colorways)
    .innerJoin(products, eq(products.id, colorways.productId))
    .where(eq(colorways.id, colorwayId));
  if (!cw || cw.product.status !== 'active' || cw.colorway.status !== 'active') return 0;
  const link = `/p/${cw.product.slug}/${cw.colorway.slug}`;
  const url = `${ctx.env.WEB_ORIGIN}${link}`;
  const name = `${cw.product.name} (${cw.colorway.name})`;
  let sent = 0;

  const message = (to: string, from: number) =>
    noticeTemplate({
      to,
      template: 'price_drop',
      subject: `Price drop: ${cw.product.name} is now ${formatINR(current)}`,
      heading: 'The price dropped',
      paragraphs: [`${name} is now ${formatINR(current)} (was ${formatINR(from)}).`],
      link: { href: url, label: 'Shop now' },
    });

  const alerts = await ctx.db.query.stockAlerts.findMany({
    where: and(eq(stockAlerts.colorwayId, colorwayId), eq(stockAlerts.kind, 'price_drop'), isNull(stockAlerts.notifiedAt)),
  });
  for (const alert of alerts) {
    if (!alert.baselinePricePaise || current >= alert.baselinePricePaise) continue;
    await ctx.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(stockAlerts)
        .set({ notifiedAt: ctx.clock.now() })
        .where(and(eq(stockAlerts.id, alert.id), isNull(stockAlerts.notifiedAt)))
        .returning();
      if (!claimed) return;
      await notify(ctx, tx, {
        userId: alert.userId,
        kind: 'price_drop',
        title: `${cw.product.name} is now ${formatINR(current)}`,
        body: `Down from ${formatINR(alert.baselinePricePaise!)}.`,
        link,
        email: message(alert.email, alert.baselinePricePaise!),
      });
      sent++;
    });
  }

  const wished = await ctx.db
    .select({ item: wishlistItems, email: users.email })
    .from(wishlistItems)
    .innerJoin(users, eq(users.id, wishlistItems.userId))
    .where(eq(wishlistItems.colorwayId, colorwayId));
  for (const { item: w, email } of wished) {
    const reference = w.priceAlertedPaise ?? w.addedPricePaise;
    if (!reference || current >= reference) continue;
    await ctx.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(wishlistItems)
        .set({ priceAlertedPaise: current })
        .where(and(eq(wishlistItems.id, w.id), sql`coalesce(${wishlistItems.priceAlertedPaise}, ${wishlistItems.addedPricePaise}) > ${current}`))
        .returning();
      if (!claimed) return;
      await notify(ctx, tx, {
        userId: w.userId,
        kind: 'price_drop',
        title: `On your wishlist: ${cw.product.name} is now ${formatINR(current)}`,
        body: `Down from ${formatINR(reference)}.`,
        link,
        email: message(email, reference),
      });
      sent++;
    });
  }
  return sent;
}
