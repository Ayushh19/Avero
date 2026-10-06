import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_common';
import { skus } from './catalog';
import { orders, returnRequests } from './orders';

export const reservationStatus = pgEnum('reservation_status', ['active', 'committed', 'released']);

export const inventoryReservations = pgTable(
  'inventory_reservations',
  {
    id: id(),
    skuId: uuid()
      .notNull()
      .references(() => skus.id),
    orderId: uuid().references(() => orders.id),
    returnRequestId: uuid().references(() => returnRequests.id),
    qty: integer().notNull(),
    status: reservationStatus().notNull().default('active'),
    expiresAt: ts(),
    createdAt: createdAt(),
    settledAt: ts(),
  },
  (t) => [
    index('reservations_order_idx').on(t.orderId),
    index('reservations_active_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'active'`),
    check('reservations_qty_positive', sql`${t.qty} > 0`),
  ],
);

/** Append-only audit trail of every stock change. */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: id(),
    skuId: uuid()
      .notNull()
      .references(() => skus.id),
    deltaOnHand: integer().notNull().default(0),
    deltaReserved: integer().notNull().default(0),
    reason: text()
      .$type<
        | 'import'
        | 'seed'
        | 'adjustment'
        | 'reserve'
        | 'release'
        | 'commit'
        | 'restock_cancel'
        | 'restock_return'
        | 'simulation'
      >()
      .notNull(),
    refType: text(),
    refId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index('inventory_movements_sku_idx').on(t.skuId, t.createdAt)],
);
