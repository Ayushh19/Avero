import { checkoutSessionPatchSchema, placeOrderSchema, startCheckoutSchema } from '@avero/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withIdempotency } from '../../lib/idempotency';
import { requesterScope } from '../../lib/requester';
import { toOrderDto } from '../orders/service';
import * as checkout from './service';

const idParam = z.object({ id: z.uuid() });

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** Create or resume the open checkout for the current bag, or for a single "buy now" item. */
  app.post('/checkout/session', async (req, reply) => ({
    session: await checkout.startSession(ctx, req, reply, startCheckoutSchema.parse(req.body ?? {})),
  }));

  app.get('/checkout/session/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return { session: await checkout.getSession(ctx, req, id) };
  });

  app.patch('/checkout/session/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return { session: await checkout.patchSession(ctx, req, id, checkoutSessionPatchSchema.parse(req.body)) };
  });

  app.post('/checkout/session/:id/quote', async (req) => {
    const { id } = idParam.parse(req.params);
    return { quote: await checkout.quoteSession(ctx, req, id) };
  });

  app.post('/checkout/place-order', async (req, reply) =>
    withIdempotency(ctx, req, reply, `checkout:${requesterScope(req)}`, async () => {
      const input = placeOrderSchema.parse(req.body);
      const order = await checkout.placeOrder(ctx, req, reply, input);
      return { status: 201, body: { order: await toOrderDto(ctx, order) } };
    }),
  );
}
