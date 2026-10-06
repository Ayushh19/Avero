import { listingQuerySchema } from '@avero/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { estimateDelivery, lookupPincode } from '../delivery/pincode';
import * as catalog from './service';

const slugParam = z.object({ slug: z.string().min(1).max(200) });

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  // Short shared caching: listings tolerate brief staleness; PDP stock is always live.
  const publicCache = 'public, max-age=30, stale-while-revalidate=60';

  app.get('/home', async (_req, reply) => {
    reply.header('cache-control', publicCache);
    return catalog.homeContent(ctx);
  });

  app.get('/categories', async (_req, reply) => {
    reply.header('cache-control', publicCache);
    return { categories: await catalog.categoryTree(ctx) };
  });

  app.get('/collections', async (_req, reply) => {
    reply.header('cache-control', publicCache);
    return { collections: await catalog.listCollections(ctx) };
  });

  app.get('/products', async (req, reply) => {
    const query = listingQuerySchema.parse(req.query);
    reply.header('cache-control', publicCache);
    const result = await catalog.listProducts(ctx, query);
    if (query.q && query.offset === 0) {
      catalog.recordSearch(ctx, query.q, result.total).catch((err) => req.log.warn({ err }, 'search log failed'));
    }
    return result;
  });

  app.get('/products/:slug', async (req, reply) => {
    const { slug } = slugParam.parse(req.params);
    reply.header('cache-control', 'no-store');
    return { product: await catalog.getProductDetail(ctx, slug) };
  });

  app.get('/products/:slug/recommendations', async (req, reply) => {
    const { slug } = slugParam.parse(req.params);
    reply.header('cache-control', publicCache);
    return { items: await catalog.recommendations(ctx, slug) };
  });

  app.get('/search/suggest', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    return catalog.suggest(ctx, q);
  });

  app.get('/search/trending', async (_req, reply) => {
    reply.header('cache-control', publicCache);
    return { queries: await catalog.trendingSearches(ctx) };
  });

  app.get('/delivery/estimate', async (req) => {
    const { pincode } = z.object({ pincode: z.string().trim().max(10) }).parse(req.query);
    return estimateDelivery(pincode, ctx.clock.now());
  });

  app.get('/pincodes/:pincode', async (req, reply) => {
    const { pincode } = z.object({ pincode: z.string().trim().max(10) }).parse(req.params);
    reply.header('cache-control', 'public, max-age=86400'); // static reference data
    return lookupPincode(pincode);
  });
}
