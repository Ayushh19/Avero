import { cancelOrderSchema, orderLookupSchema } from '@avero/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withIdempotency } from '../../lib/idempotency';
import { requesterScope } from '../../lib/requester';
import { returnOptions } from '../returns/service';
import { cancelOrder } from './cancellation';
import { renderInvoice } from './invoice';
import * as orders from './service';

const numberParam = z.object({ orderNumber: z.string().trim().min(1).max(32) });
const tokenQuery = z.object({ token: z.string().max(200).optional() });

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/orders', async (req) => orders.listOrders(ctx, req));

  /** Owner, the guest device that placed it, or a signed `?token=` link. */
  app.get('/orders/:orderNumber', async (req) => {
    const { orderNumber } = numberParam.parse(req.params);
    const { token } = tokenQuery.parse(req.query);
    return { order: await orders.toOrderDto(ctx, await orders.accessibleOrder(ctx, req, orderNumber, token)) };
  });

  app.post('/orders/lookup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { orderNumber, email } = orderLookupSchema.parse(req.body);
    return orders.lookupOrder(ctx, orderNumber, email);
  });

  app.post('/orders/claim', async (req) => orders.claimGuestOrders(ctx, req));

  /** Whole order (no itemIds) or whole lines, before shipping. */
  app.post('/orders/:orderNumber/cancel', async (req, reply) => {
    const { orderNumber } = numberParam.parse(req.params);
    const { token } = tokenQuery.parse(req.query);
    return withIdempotency(ctx, req, reply, `cancel:${requesterScope(req)}`, async () => {
      const input = cancelOrderSchema.parse(req.body);
      const order = await cancelOrder(ctx, req, orderNumber, input, token);
      return { status: 200, body: { order: await orders.toOrderDto(ctx, order) } };
    });
  });

  app.get('/orders/:orderNumber/invoice', async (req, reply) => {
    const { orderNumber } = numberParam.parse(req.params);
    const { token } = tokenQuery.parse(req.query);
    const html = await renderInvoice(ctx, await orders.accessibleOrder(ctx, req, orderNumber, token));
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/orders/:orderNumber/return-options', async (req) => {
    const { orderNumber } = numberParam.parse(req.params);
    const { token } = tokenQuery.parse(req.query);
    return returnOptions(ctx, req, orderNumber, token);
  });
}
