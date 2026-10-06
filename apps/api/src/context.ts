import type { Env } from './config/env';
import type { CatalogIndex } from './modules/catalog/catalog-index';
import type { Db } from './db/client';
import type { SimulatedClock } from './lib/clock';
import type { Mailer } from './lib/mailer';

/** Dependencies shared by services and job handlers. */
export interface AppContext {
  env: Env;
  db: Db;
  clock: SimulatedClock;
  mailer: Mailer;
  catalog: CatalogIndex;
  /**
   * How the simulated gateway delivers webhooks: POSTs the signed body to our webhook route through
   * the full HTTP pipeline (Fastify inject, so it needs no network port). Returns the HTTP status.
   */
  webhookTransport: (body: string, signature: string) => Promise<number>;
}
