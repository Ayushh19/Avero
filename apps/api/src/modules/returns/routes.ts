import { createReturnSchema } from '@avero/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withIdempotency } from '../../lib/idempotency';
import { requesterScope } from '../../lib/requester';
import { requireUser } from '../../plugins/session';
import * as returns from './service';

const rmaParam = z.object({ rma: z.string().trim().min(1).max(32) });
const tokenQuery = z.object({ token: z.string().max(200).optional() });

export async function returnRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** Members and guests (guest device cookie or the order's signed `?token=`). */
  app.post('/returns', async (req, reply) => {
    const { token } = tokenQuery.parse(req.query);
    return withIdempotency(ctx, req, reply, `returns:${requesterScope(req)}`, async () => {
      const input = createReturnSchema.parse(req.body);
      const ret = await returns.createReturn(ctx, req, input, token);
      return { status: 201, body: { return: await returns.toReturnDto(ctx, ret) } };
    });
  });

  app.get('/returns', async (req) => ({ returns: await returns.returnSummaries(ctx.db, { userId: requireUser(req).id }) }));

  app.get('/returns/:rma', async (req) => {
    const { rma } = rmaParam.parse(req.params);
    const { token } = tokenQuery.parse(req.query);
    return { return: await returns.getReturn(ctx, req, rma, token) };
  });

  app.post('/returns/:rma/cancel', async (req) => {
    const { rma } = rmaParam.parse(req.params);
    const { token } = tokenQuery.parse(req.query);
    const ret = await returns.cancelReturn(ctx, req, rma, token);
    return { return: await returns.toReturnDto(ctx, ret) };
  });
}
