import 'dotenv/config';
import { openDatabase, runMigrations } from './client';

const dir = process.env.DATABASE_DIR ?? './.data/pglite';
const database = await openDatabase(dir);
await runMigrations(database.db);
await database.close();
console.log(`Migrations applied to ${dir}`);
