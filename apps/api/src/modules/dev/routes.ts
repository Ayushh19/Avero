import { asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  colorways,
  coupons,
  couponRedemptions,
  inventoryMovements,
  inventoryReservations,
  orderEvents,
  orders,
  products,
  returnRequests,
  paymentAttempts,
  paymentEvents,
  pointsLedger,
  priceHistory,
  refunds,
  sentEmails,
  skus,
  users,
} from '../../db/schema';
import { AppError } from '../../lib/errors';
import { enqueue } from '../../jobs/queue';
import { importCatalog } from '../catalog/importer/run';
import { enqueuePriceDropCheck } from '../alerts/price-drops';
import { advanceNow } from '../fulfilment/service';
import { pointsBalance } from '../loyalty/points';
import { setRefundFailures } from '../payments/gateway-sim/service';
import { advanceReturnNow } from '../returns/service';
import { seedReviews } from '../reviews/seed';

/** Dev-only simulation tools. Registered only when SIMULATION_TOOLS=true. Not an admin panel. */
export async function devRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/dev/emails', async () => ({
    emails: await ctx.db.select().from(sentEmails).orderBy(desc(sentEmails.createdAt)).limit(50),
  }));

  app.get('/dev/clock', async () => ({
    now: ctx.clock.now().toISOString(),
    offsetMs: ctx.clock.offsetMs(),
  }));

  app.post('/dev/clock/advance', async (req) => {
    const { minutes } = z
      .object({ minutes: z.number().int().positive().max(60 * 24 * 365) })
      .parse(req.body);
    await ctx.clock.advance(minutes * 60_000);
    return { now: ctx.clock.now().toISOString(), offsetMs: ctx.clock.offsetMs() };
  });

  app.post('/dev/catalog/import', async (req) => {
    const opts = z
      .object({ dryRun: z.boolean().optional(), reprice: z.boolean().optional(), resetStock: z.boolean().optional() })
      .parse(req.body ?? {});
    const report = await importCatalog(ctx.db, ctx.clock, {
      sourceUrl: ctx.env.SKU_API_URL,
      mediaDir: ctx.env.MEDIA_DIR,
      ...opts,
      log: (m) => req.log.info(m),
    });
    ctx.catalog.invalidate();
    return report;
  });

  /** Simulate catalog changes (price change, stock-out, discontinuation) to exercise edge cases. */
  app.post('/dev/skus/:skuCode', async (req) => {
    const { skuCode } = z.object({ skuCode: z.string() }).parse(req.params);
    const patch = z
      .object({
        pricePaise: z.number().int().positive().optional(),
        onHand: z.number().int().nonnegative().optional(),
        status: z.enum(['active', 'discontinued']).optional(),
      })
      .parse(req.body);
    const updated = await ctx.db.transaction(async (tx) => {
      const sku = await tx.query.skus.findFirst({ where: eq(skus.skuCode, skuCode) });
      if (!sku) throw new AppError('NOT_FOUND', 'SKU not found');
      const set: Partial<typeof skus.$inferInsert> = {};
      if (patch.pricePaise !== undefined && patch.pricePaise !== sku.pricePaise) {
        set.pricePaise = patch.pricePaise;
        if (patch.pricePaise > sku.mrpPaise) set.mrpPaise = patch.pricePaise;
        await tx.insert(priceHistory).values({ skuId: sku.id, oldPricePaise: sku.pricePaise, newPricePaise: patch.pricePaise });
        if (patch.pricePaise < sku.pricePaise) await enqueuePriceDropCheck(tx, sku.colorwayId);
      }
      if (patch.onHand !== undefined) {
        if (patch.onHand < sku.reserved) throw new AppError('CONFLICT', `${sku.reserved} units are reserved by pending orders`);
        set.onHand = patch.onHand;
        await tx.insert(inventoryMovements).values({ skuId: sku.id, deltaOnHand: patch.onHand - sku.onHand, reason: 'simulation' });
      }
      if (patch.status) set.status = patch.status;
      const [row] = await tx.update(skus).set(set).where(eq(skus.id, sku.id)).returning();
      if (row && sku.onHand - sku.reserved <= 0 && row.onHand - row.reserved > 0) {
        await enqueue(tx, 'stock_alert.check', { skuId: row.id }, { dedupeKey: `stock-alert:${row.id}` });
      }
      return row;
    });
    ctx.catalog.invalidate();
    return { sku: updated };
  });

  app.post('/dev/clock/reset', async () => {
    await ctx.clock.reset();
    return { now: ctx.clock.now().toISOString(), offsetMs: 0 };
  });

  /** Make a coupon expire now (edge case: coupon expires between quote and placement). */
  app.post('/dev/coupons/:code/expire', async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const [row] = await ctx.db
      .update(coupons)
      .set({ endsAt: new Date(ctx.clock.now().getTime() - 1000) })
      .where(eq(coupons.code, code.toUpperCase()))
      .returning();
    if (!row) throw new AppError('NOT_FOUND', 'Coupon not found');
    return { coupon: row };
  });

  /** Grant available points (earning only starts in Phase 5; this lets checkout redemption be exercised). */
  app.post('/dev/points/grant', async (req) => {
    const { email, points } = z
      .object({ email: z.string().trim().toLowerCase(), points: z.number().int().positive().max(100_000) })
      .parse(req.body);
    const user = await ctx.db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) throw new AppError('NOT_FOUND', 'User not found');
    await ctx.db.insert(pointsLedger).values({
      userId: user.id,
      delta: points,
      kind: 'bonus',
      status: 'available',
      note: 'Dev grant',
      availableAt: ctx.clock.now(),
    });
    return { balance: await pointsBalance(ctx.db, user.id) };
  });

  /** Everything about one order: state, events, attempts, gateway view, webhooks, stock, offers. */
  app.get('/dev/orders/:orderNumber', async (req) => {
    const { orderNumber } = z.object({ orderNumber: z.string() }).parse(req.params);
    const order = await ctx.db.query.orders.findFirst({ where: eq(orders.orderNumber, orderNumber.toUpperCase()) });
    if (!order) throw new AppError('NOT_FOUND', 'Order not found');
    const attempts = await ctx.db.query.paymentAttempts.findMany({ where: eq(paymentAttempts.orderId, order.id), orderBy: asc(paymentAttempts.createdAt) });
    const refs = attempts.map((a) => a.gatewayRef);
    return {
      order,
      events: await ctx.db.query.orderEvents.findMany({ where: eq(orderEvents.orderId, order.id), orderBy: asc(orderEvents.occurredAt) }),
      attempts,
      gateway: refs.length
        ? await ctx.db.query.gatewaySimCharges.findMany({ where: (g, { inArray }) => inArray(g.gatewayRef, refs) })
        : [],
      webhooks: attempts.length
        ? await ctx.db.query.paymentEvents.findMany({
            where: (e, { inArray }) => inArray(e.attemptId, attempts.map((a) => a.id)),
            orderBy: asc(paymentEvents.receivedAt),
          })
        : [],
      reservations: await ctx.db.query.inventoryReservations.findMany({ where: eq(inventoryReservations.orderId, order.id) }),
      couponRedemption: await ctx.db.query.couponRedemptions.findFirst({ where: eq(couponRedemptions.orderId, order.id) }),
      points: await ctx.db.query.pointsLedger.findMany({ where: eq(pointsLedger.orderId, order.id) }),
      refunds: await ctx.db.query.refunds.findMany({ where: eq(refunds.orderId, order.id) }),
    };
  });

  /** Perform an order's next fulfilment step now (packed → shipped → out for delivery → delivered). */
  app.post('/dev/orders/:orderNumber/advance', async (req) => {
    const { orderNumber } = z.object({ orderNumber: z.string() }).parse(req.params);
    return { status: await advanceNow(ctx, orderNumber) };
  });

  /** Perform a return's next step now (picked up → received → inspected/completed). */
  app.post('/dev/returns/:rma/advance', async (req) => {
    const { rma } = z.object({ rma: z.string() }).parse(req.params);
    return { status: await advanceReturnNow(ctx, rma) };
  });

  /** Make the simulated gateway fail the next N refund requests (exercises retry → points fallback). */
  app.post('/dev/refunds/failure-mode', async (req) => {
    const { failures } = z.object({ failures: z.number().int().min(0).max(20) }).parse(req.body);
    return { refundFailuresRemaining: await setRefundFailures(ctx, failures) };
  });

  /** Seed sample verified reviews (fictional reviewers with past delivered orders). Idempotent. */
  app.post('/dev/reviews/seed', async () => {
    const report = await seedReviews(ctx.db, ctx.clock);
    ctx.catalog.invalidate();
    return report;
  });

  /* ---- read-only views for the simulation panel (/dev/simulate) ---- */

  /** Clock, background job health and gateway knobs. */
  app.get('/dev/state', async () => {
    const [jobsRow] = (await ctx.db.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (WHERE status = 'pending' AND run_at <= ${ctx.clock.now()})::int AS due,
             count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM jobs`)).rows as { pending: number; due: number; failed: number }[];
    const settings = await ctx.db.query.gatewaySimSettings.findFirst();
    return {
      now: ctx.clock.now().toISOString(),
      offsetMs: ctx.clock.offsetMs(),
      jobs: jobsRow,
      refundFailuresRemaining: settings?.refundFailuresRemaining ?? 0,
    };
  });

  /** Most recent orders (any customer), newest first. */
  app.get('/dev/orders', async () => ({
    orders: await ctx.db
      .select({
        orderNumber: orders.orderNumber,
        status: orders.status,
        kind: orders.kind,
        email: orders.email,
        totalPaise: orders.totalPaise,
        placedAt: orders.placedAt,
        returnWindowEndsAt: orders.returnWindowEndsAt,
      })
      .from(orders)
      .where(sql`${orders.email} NOT LIKE '%@reviewers.avero.local'`)
      .orderBy(desc(orders.placedAt))
      .limit(30),
  }));

  app.get('/dev/returns', async () => ({
    returns: await ctx.db
      .select({ rmaNumber: returnRequests.rmaNumber, status: returnRequests.status, kind: returnRequests.kind, orderNumber: orders.orderNumber, createdAt: returnRequests.createdAt })
      .from(returnRequests)
      .innerJoin(orders, eq(orders.id, returnRequests.orderId))
      .orderBy(desc(returnRequests.createdAt))
      .limit(30),
  }));

  /** Every size with its stock and price, for quick edits. */
  app.get('/dev/skus', async () => ({
    skus: await ctx.db
      .select({
        skuCode: skus.skuCode,
        sizeLabel: skus.sizeLabel,
        pricePaise: skus.pricePaise,
        onHand: skus.onHand,
        reserved: skus.reserved,
        status: skus.status,
        productName: products.name,
        colorName: colorways.name,
      })
      .from(skus)
      .innerJoin(colorways, eq(colorways.id, skus.colorwayId))
      .innerJoin(products, eq(products.id, colorways.productId))
      .orderBy(asc(products.name), asc(colorways.name), asc(skus.sizeSort)),
  }));
}
