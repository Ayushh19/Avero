import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema';

export type Db = PgliteDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export interface Database {
  client: PGlite;
  db: Db;
  close: () => Promise<void>;
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * PGlite must never be opened by two processes at once (it would corrupt the data directory),
 * so every opener takes a pid lock file next to it.
 */
function acquireLock(dataDir: string): () => void {
  const lockPath = `${resolve(dataDir)}.lock`;
  try {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0); // throws if the process no longer exists
        throw new Error(
          `Database ${dataDir} is in use by process ${pid}. Stop the API first, or use the dev endpoints (e.g. POST /api/v1/dev/catalog/import) while it runs.`,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  writeFileSync(lockPath, String(process.pid));
  return () => rmSync(lockPath, { force: true });
}

/**
 * Opens the embedded Postgres. PGlite is single-connection and lives in this process:
 * there must only ever be one instance per data directory.
 */
export async function openDatabase(dataDir: string): Promise<Database> {
  const inMemory = dataDir === 'memory' || dataDir === '';
  if (!inMemory) mkdirSync(dataDir, { recursive: true });
  const release = inMemory ? () => undefined : acquireLock(dataDir);
  const client = await PGlite.create(inMemory ? undefined : dataDir, {
    extensions: { pg_trgm },
  });
  const db = drizzle({ client, schema, casing: 'snake_case' });
  return {
    client,
    db,
    close: async () => {
      await client.close();
      release();
    },
  };
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
