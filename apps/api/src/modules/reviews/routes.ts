import { createReviewSchema, priceAlertSchema, reviewListQuerySchema, updateReviewSchema } from '@avero/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { requireUser } from '../../plugins/session';
import { createPriceAlert } from '../alerts/price-drops';
import { frequentlyBoughtTogether, personalRows } from '../catalog/personal';
import { loyaltySummary } from '../loyalty/lifecycle';
import { checkReferralCode, referralSummary } from '../referrals/service';
import * as reviews from './service';

const idParam = z.object({ id: z.uuid() });
const slugParam = z.object({ slug: z.string().min(1).max(200) });

/** Phase 5 engagement: reviews, rewards, referrals, price alerts, recommendations. */
export async function engagementRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  /* ---- reviews ---- */
  app.get('/products/:slug/reviews', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { slug } = slugParam.parse(req.params);
    return reviews.listProductReviews(ctx, slug, reviewListQuerySchema.parse(req.query), req.user?.id ?? null);
  });
  app.get('/reviews/eligible', async (req) => ({ items: await reviews.reviewableItems(ctx, requireUser(req).id) }));
  app.get('/reviews/mine', async (req) => ({ reviews: await reviews.myReviews(ctx, requireUser(req).id) }));
  app.post('/reviews', async (req, reply) => {
    const user = requireUser(req);
    const review = await reviews.createReview(ctx, user.id, createReviewSchema.parse(req.body));
    return reply.status(201).send({ id: review.id });
  });
  app.patch('/reviews/:id', async (req) => {
    const user = requireUser(req);
    const { id } = idParam.parse(req.params);
    const review = await reviews.updateReview(ctx, user.id, id, updateReviewSchema.parse(req.body));
    return { id: review.id };
  });
  app.delete('/reviews/:id', async (req, reply) => {
    const user = requireUser(req);
    await reviews.deleteReview(ctx, user.id, idParam.parse(req.params).id);
    return reply.status(204).send();
  });
  app.post('/reviews/:id/helpful', async (req) => {
    const user = requireUser(req);
    const { helpful } = z.object({ helpful: z.boolean().default(true) }).parse(req.body ?? {});
    return reviews.setHelpful(ctx, user.id, idParam.parse(req.params).id, helpful);
  });

  /* ---- rewards & referrals ---- */
  app.get('/loyalty', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return loyaltySummary(ctx, requireUser(req).id);
  });
  app.get('/referrals', async (req) => referralSummary(ctx, requireUser(req).id));
  app.get('/referrals/:code', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { code } = z.object({ code: z.string().trim().min(3).max(20) }).parse(req.params);
    return checkReferralCode(ctx, code);
  });

  /* ---- alerts ---- */
  app.post('/alerts/price', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const input = priceAlertSchema.parse(req.body);
    const email = req.user ? req.user.email : input.email;
    if (!email) throw new AppError('VALIDATION_FAILED', 'Enter your email to get notified');
    const { baselinePricePaise } = await createPriceAlert(ctx, { colorwayId: input.colorwayId, email, userId: req.user?.id ?? null });
    return { ok: true, email, baselinePricePaise };
  });

  /* ---- recommendations ---- */
  app.get('/products/:slug/frequently-bought-together', async (req, reply) => {
    const { slug } = slugParam.parse(req.params);
    reply.header('cache-control', 'public, max-age=30, stale-while-revalidate=60');
    return { items: await frequentlyBoughtTogether(ctx, slug) };
  });
  app.get('/home/personal', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { viewed } = z.object({ viewed: z.string().max(4000).optional() }).parse(req.query);
    const ids = (viewed ?? '').split(',').filter((v) => z.uuid().safeParse(v).success).slice(0, 20);
    return { rows: await personalRows(ctx, req.user?.id ?? null, ids) };
  });
}
