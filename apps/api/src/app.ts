import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Env } from './config/env';
import type { AppContext } from './context';
import { openDatabase, runMigrations, type Database } from './db/client';
import { registerJobHandlers } from './jobs/handlers';
import { JobWorker } from './jobs/worker';
import { SimulatedClock } from './lib/clock';
import { Mailer } from './lib/mailer';
import { accountRoutes } from './modules/account/routes';
import { authRoutes, registerGoogleCallbackAlias } from './modules/auth/routes';
import { cartRoutes } from './modules/cart/routes';
import { checkoutRoutes } from './modules/checkout/routes';
import { notificationRoutes } from './modules/notifications/routes';
import { orderRoutes } from './modules/orders/routes';
import { returnRoutes } from './modules/returns/routes';
import { engagementRoutes } from './modules/reviews/routes';
import { paymentRoutes } from './modules/payments/routes';
import { wishlistRoutes } from './modules/wishlist/routes';
import { CatalogIndex } from './modules/catalog/catalog-index';
import { catalogRoutes } from './modules/catalog/routes';
import { devRoutes } from './modules/dev/routes';
import { systemRoutes } from './modules/system/routes';
import { registerErrorHandling } from './plugins/error-handler';
import { registerSession } from './plugins/session';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
    worker: JobWorker;
  }
}

export interface BuildOptions {
  env: Env;
  logger?: FastifyServerOptions['logger'];
  /** Start the background job loop (off in tests; call `app.worker.runDue()` instead). */
  startWorker?: boolean;
  /** Reuse an already-open database (tests). */
  database?: Database;
}

export async function buildApp(options: BuildOptions): Promise<FastifyInstance> {
  const { env } = options;
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });

  const database = options.database ?? (await openDatabase(env.DATABASE_DIR));
  await runMigrations(database.db);

  const clock = new SimulatedClock(database.db);
  await clock.load();

  const ctx: AppContext = {
    env,
    db: database.db,
    clock,
    mailer: new Mailer(database.db, env.MAIL_FROM, app.log, env.SMTP_URL),
    catalog: new CatalogIndex(database.db, clock),
    webhookTransport: async (body, signature) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/payments/webhook',
          headers: { 'content-type': 'application/json', 'x-avero-signature': signature },
          payload: body,
        })
      ).statusCode,
  };
  app.decorate('ctx', ctx);

  const worker = new JobWorker(ctx, app.log);
  registerJobHandlers(worker);
  app.decorate('worker', worker);

  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(rateLimit, { global: false });

  // Rehosted catalog imagery. File names are source image ids, so content never changes.
  const mediaRoot = resolve(env.MEDIA_DIR);
  mkdirSync(mediaRoot, { recursive: true });
  await app.register(fastifyStatic, {
    root: mediaRoot,
    prefix: '/media/',
    decorateReply: false,
    immutable: true,
    maxAge: '365d',
  });

  registerErrorHandling(app);
  registerSession(app);

  await app.register(
    async (api) => {
      await api.register(systemRoutes);
      await api.register(authRoutes);
      await api.register(catalogRoutes);
      await api.register(cartRoutes);
      await api.register(wishlistRoutes);
      await api.register(accountRoutes);
      await api.register(checkoutRoutes);
      await api.register(paymentRoutes);
      await api.register(orderRoutes);
      await api.register(returnRoutes);
      await api.register(notificationRoutes);
      await api.register(engagementRoutes);
      if (env.SIMULATION_TOOLS) await api.register(devRoutes);
    },
    { prefix: '/api/v1' },
  );
  registerGoogleCallbackAlias(app);

  app.addHook('onReady', async () => {
    if (options.startWorker) await worker.start();
  });
  app.addHook('onClose', async () => {
    worker.stop();
    if (!options.database) await database.close();
  });

  return app;
}
