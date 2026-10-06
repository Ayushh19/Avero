import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Tx } from '../../db/client';
import { inventoryMovements, inventoryReservations, skus } from '../../db/schema';
import { AppError } from '../../lib/errors';

/**
 * Stock reservations for orders (docs/BUSINESS_RULES.md §Inventory).
 * available = on_hand − reserved; every change is a conditional UPDATE (plus CHECK constraints)
 * and writes an inventory_movements row. Callers invalidate the catalog index after commit.
 */

export interface ReserveLine {
  skuId: string;
  qty: number;
  sizeLabel: string;
  productName: string;
}

/**
 * Reserves every line or none: throws SKU_OUT_OF_STOCK (listing each short line) and the caller's
 * transaction rolls back the lines already reserved.
 */
export async function reserveLines(tx: Tx, orderId: string, lines: ReserveLine[], expiresAt: Date): Promise<void> {
  const short: { skuId: string; requested: number; available: number }[] = [];
  for (const line of lines) {
    const [row] = await tx
      .update(skus)
      .set({ reserved: sql`${skus.reserved} + ${line.qty}` })
      .where(and(eq(skus.id, line.skuId), eq(skus.status, 'active'), sql`${skus.onHand} - ${skus.reserved} >= ${line.qty}`))
      .returning({ id: skus.id });
    if (!row) {
      const sku = await tx.query.skus.findFirst({ where: eq(skus.id, line.skuId) });
      short.push({ skuId: line.skuId, requested: line.qty, available: sku ? Math.max(0, sku.onHand - sku.reserved) : 0 });
      continue;
    }
    const [reservation] = await tx
      .insert(inventoryReservations)
      .values({ skuId: line.skuId, orderId, qty: line.qty, expiresAt })
      .returning({ id: inventoryReservations.id });
    await tx.insert(inventoryMovements).values({
      skuId: line.skuId,
      deltaReserved: line.qty,
      reason: 'reserve',
      refType: 'reservation',
      refId: reservation!.id,
    });
  }
  if (short.length) {
    const first = lines.find((l) => l.skuId === short[0]!.skuId)!;
    const message =
      short.length === 1
        ? `${first.productName} in size ${first.sizeLabel} just sold out`
        : 'Some items in your bag just sold out';
    throw new AppError('SKU_OUT_OF_STOCK', message, { lines: short });
  }
}

type Owner = { orderId: string } | { returnRequestId: string };
const ownedBy = (o: Owner) =>
  'orderId' in o ? eq(inventoryReservations.orderId, o.orderId) : eq(inventoryReservations.returnRequestId, o.returnRequestId);

/** Payment succeeded: on_hand −= n, reserved −= n for each active reservation. */
export async function commitReservations(ctx: AppContext, tx: Tx, orderId: string): Promise<number> {
  return commitOwned(ctx, tx, { orderId });
}

/** Exchange inspected: the replacement units leave stock. */
export async function commitReturnReservations(ctx: AppContext, tx: Tx, returnRequestId: string): Promise<number> {
  return commitOwned(ctx, tx, { returnRequestId });
}

async function commitOwned(ctx: AppContext, tx: Tx, owner: Owner): Promise<number> {
  const active = await tx.query.inventoryReservations.findMany({
    where: and(ownedBy(owner), eq(inventoryReservations.status, 'active')),
  });
  for (const r of active) {
    await tx
      .update(skus)
      .set({ onHand: sql`${skus.onHand} - ${r.qty}`, reserved: sql`${skus.reserved} - ${r.qty}` })
      .where(eq(skus.id, r.skuId));
    await tx
      .update(inventoryReservations)
      .set({ status: 'committed', settledAt: ctx.clock.now() })
      .where(eq(inventoryReservations.id, r.id));
    await tx.insert(inventoryMovements).values({
      skuId: r.skuId,
      deltaOnHand: -r.qty,
      deltaReserved: -r.qty,
      reason: 'commit',
      refType: 'reservation',
      refId: r.id,
    });
    await tx.execute(sql`
      UPDATE products SET sold_count = sold_count + ${r.qty}
      WHERE id = (SELECT c.product_id FROM skus s JOIN colorways c ON c.id = s.colorway_id WHERE s.id = ${r.skuId})`);
  }
  return active.length;
}

/** Order expired / payment window over: reserved −= n for each active reservation. */
export async function releaseReservations(ctx: AppContext, tx: Tx, orderId: string): Promise<number> {
  return releaseOwned(ctx, tx, { orderId });
}

/** Exchange cancelled before pickup: give the held replacement units back. */
export async function releaseReturnReservations(ctx: AppContext, tx: Tx, returnRequestId: string): Promise<number> {
  return releaseOwned(ctx, tx, { returnRequestId });
}

async function releaseOwned(ctx: AppContext, tx: Tx, owner: Owner): Promise<number> {
  const released = await tx
    .update(inventoryReservations)
    .set({ status: 'released', settledAt: ctx.clock.now() })
    .where(and(ownedBy(owner), eq(inventoryReservations.status, 'active')))
    .returning();
  for (const r of released) {
    await tx.update(skus).set({ reserved: sql`${skus.reserved} - ${r.qty}` }).where(eq(skus.id, r.skuId));
    await tx.insert(inventoryMovements).values({
      skuId: r.skuId,
      deltaReserved: -r.qty,
      reason: 'release',
      refType: 'reservation',
      refId: r.id,
    });
  }
  return released.length;
}

/**
 * Exchange: hold the replacement units from request until inspection (no expiry). False when the
 * size is unavailable — the caller answers EXCHANGE_UNAVAILABLE and the shopper can return instead.
 */
export async function reserveForReturn(tx: Tx, returnRequestId: string, skuId: string, qty: number): Promise<boolean> {
  const [row] = await tx
    .update(skus)
    .set({ reserved: sql`${skus.reserved} + ${qty}` })
    .where(and(eq(skus.id, skuId), eq(skus.status, 'active'), sql`${skus.onHand} - ${skus.reserved} >= ${qty}`))
    .returning({ id: skus.id });
  if (!row) return false;
  const [reservation] = await tx.insert(inventoryReservations).values({ skuId, returnRequestId, qty }).returning({ id: inventoryReservations.id });
  await tx.insert(inventoryMovements).values({ skuId, deltaReserved: qty, reason: 'reserve', refType: 'reservation', refId: reservation!.id });
  return true;
}
