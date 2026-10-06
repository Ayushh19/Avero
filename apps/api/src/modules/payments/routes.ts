import { createPaymentAttemptSchema, gatewaySubmitSchema } from '@avero/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withIdempotency } from '../../lib/idempotency';
import { requesterScope } from '../../lib/requester';
import { toAttemptDto } from '../orders/service';
import * as gateway from './gateway-sim/service';
import * as payments from './service';

const idParam = z.object({ id: z.uuid() });
const refParam = z.object({ gatewayRef: z.string().regex(/^gw_[A-Za-z0-9_-]{8,40}$/) });

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.post('/payments/attempts', async (req, reply) => {
    const scope = `payments:${requesterScope(req)}`;
    return withIdempotency(ctx, req, reply, scope, async () => {
      const input = createPaymentAttemptSchema.parse(req.body);
      const key = `${scope}:${req.headers['idempotency-key'] as string}`;
      const attempt = await payments.createAttempt(ctx, req, input, key);
      return {
        status: 201,
        body: { attempt: toAttemptDto(attempt, input.orderNumber.toUpperCase()), gatewayUrl: `/checkout/pay/${attempt.id}` },
      };
    });
  });

  /** Polled by the processing page. */
  app.get('/payments/attempts/:id', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = idParam.parse(req.params);
    return payments.attemptStatus(ctx, req, id);
  });

  // Signed gateway callbacks. Raw body needed for the HMAC, so this route gets its own JSON parser
  // (scoped to this plugin). CSRF-exempt in plugins/session.ts.
  await app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    hook.post('/payments/webhook', async (req) =>
      payments.processWebhook(ctx, req.body as string, req.headers['x-avero-signature'] as string | undefined),
    );
  });

  /* ---- the simulated gateway's hosted page (would live on the provider's domain) ---- */

  app.get('/payments/sim/:gatewayRef', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { gatewayRef } = refParam.parse(req.params);
    return { charge: await gateway.getChargePage(ctx, gatewayRef) };
  });

  app.post('/payments/sim/:gatewayRef/submit', async (req) => {
    const { gatewayRef } = refParam.parse(req.params);
    const { scenario, pendingResolution } = gatewaySubmitSchema.parse(req.body);
    return gateway.submitCharge(ctx, gatewayRef, scenario, pendingResolution);
  });
}
