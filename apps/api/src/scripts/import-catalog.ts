import 'dotenv/config';
import { loadEnv } from '../config/env';
import { openDatabase, runMigrations } from '../db/client';
import { SimulatedClock } from '../lib/clock';
import { importCatalog } from '../modules/catalog/importer/run';

const args = new Set(process.argv.slice(2));
const env = loadEnv();
const { db, close } = await openDatabase(env.DATABASE_DIR);

try {
  await runMigrations(db);
  const clock = new SimulatedClock(db);
  await clock.load();
  const report = await importCatalog(db, clock, {
    sourceUrl: env.SKU_API_URL,
    mediaDir: env.MEDIA_DIR,
    dryRun: args.has('--dry-run'),
    reprice: args.has('--reprice'),
    resetStock: args.has('--reset-stock'),
    log: (m) => console.log(m),
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await close();
}
