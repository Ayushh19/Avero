import 'dotenv/config';
import { loadEnv } from '../config/env';
import { openDatabase, runMigrations } from '../db/client';
import { SimulatedClock } from '../lib/clock';
import { seedReviews } from '../modules/reviews/seed';

/** CLI: sample verified reviews. While the API is running use POST /api/v1/dev/reviews/seed instead. */
const env = loadEnv();
const { db, close } = await openDatabase(env.DATABASE_DIR);
try {
  await runMigrations(db);
  const clock = new SimulatedClock(db);
  await clock.load();
  console.log(await seedReviews(db, clock));
} finally {
  await close();
}
