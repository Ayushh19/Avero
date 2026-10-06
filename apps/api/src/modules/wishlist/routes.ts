import { recentlyViewedSchema, stockAlertSchema, wishlistMergeSchema } from '@avero/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { requireUser } from '../../plugins/session';
import * as wishlist from './service';

const colorwayParam = z.object({ colorwayId: z.uuid() });

export async function wishlistRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/wishlist', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { items: await wishlist.listWishlist(ctx, requireUser(req).id) };
  });

  app.put('/wishlist/:colorwayId', async (req, reply) => {
    const { colorwayId } = colorwayParam.parse(req.params);
    await wishlist.addToWishlist(ctx, requireUser(req).id, colorwayId);
    return reply.status(204).send();
  });

  app.delete('/wishlist/:colorwayId', async (req, reply) => {
    const { colorwayId } = colorwayParam.parse(req.params);
    await wishlist.removeFromWishlist(ctx, requireUser(req).id, colorwayId);
    return reply.status(204).send();
  });

  app.post('/wishlist/merge', async (req) => {
    const { colorwayIds } = wishlistMergeSchema.parse(req.body);
    const added = await wishlist.mergeWishlist(ctx, requireUser(req).id, colorwayIds);
    return { added, items: await wishlist.listWishlist(ctx, requireUser(req).id) };
  });

  /** Cards for a guest's locally stored wishlist / recently viewed. */
  app.get('/products/by-colorway', async (req) => {
    const { ids } = z.object({ ids: z.string().max(4000) }).parse(req.query);
    const list = [...new Set(ids.split(',').filter((id) => z.uuid().safeParse(id).success))].slice(0, 50);
    const cards = await wishlist.cardsFor(ctx, list);
    return { items: list.flatMap((id) => cards.get(id) ?? []) };
  });

  app.get('/recently-viewed', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { items: await wishlist.listRecentlyViewed(ctx, requireUser(req).id) };
  });

  app.post('/recently-viewed', async (req, reply) => {
    const { colorwayIds } = recentlyViewedSchema.parse(req.body);
    await wishlist.recordViews(ctx, requireUser(req).id, colorwayIds);
    return reply.status(204).send();
  });

  app.post('/alerts/stock', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const input = stockAlertSchema.parse(req.body);
    const email = req.user ? req.user.email : input.email;
    if (!email) throw new AppError('VALIDATION_FAILED', 'Enter your email to get notified');
    await wishlist.createStockAlert(ctx, { skuId: input.skuId, email, userId: req.user?.id ?? null });
    return { ok: true, email };
  });
}
