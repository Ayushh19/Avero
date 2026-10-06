import 'dotenv/config';
import { openDatabase, runMigrations } from './client';
import { ensureSizeCharts } from '../modules/catalog/size-charts';
import { coupons } from './schema';

/**
 * Dev seed for data that does not come from the external SKU API.
 * The catalog itself is imported in Phase 1 (see docs/ROADMAP.md).
 */
const dir = process.env.DATABASE_DIR ?? './.data/pglite';
const { db, close } = await openDatabase(dir);
await runMigrations(db);

const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

await ensureSizeCharts(db);

await db
  .insert(coupons)
  .values([
    {
      code: 'WELCOME10',
      description: '10% off your first order (up to ₹500)',
      kind: 'percent',
      value: 1000,
      maxDiscountPaise: 500_00,
      minOrderPaise: 1_499_00,
      startsAt: days(-1),
      firstOrderOnly: true,
    },
    {
      code: 'FLAT500',
      description: '₹500 off orders above ₹4,999',
      kind: 'flat',
      value: 500_00,
      minOrderPaise: 4_999_00,
      startsAt: days(-1),
      endsAt: days(30),
      perUserLimit: 2,
    },
    {
      code: 'LAST3',
      description: '15% off — only 3 redemptions in total (usage-limit edge case)',
      kind: 'percent',
      value: 1500,
      startsAt: days(-1),
      usageLimit: 3,
    },
    {
      code: 'EXPIRED20',
      description: 'Expired coupon (edge case)',
      kind: 'percent',
      value: 2000,
      startsAt: days(-30),
      endsAt: days(-1),
    },
  ])
  .onConflictDoNothing();

await close();
console.log('Seed complete');
