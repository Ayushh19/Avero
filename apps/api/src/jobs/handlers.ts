import type { EmailMessage } from '../lib/mailer';
import { advanceFulfilment } from '../modules/fulfilment/service';
import * as gateway from '../modules/payments/gateway-sim/service';
import { processRefund } from '../modules/refunds/service';
import { advanceReturn } from '../modules/returns/service';
import { checkPriceDrop } from '../modules/alerts/price-drops';
import { confirmOrderPoints, expireDuePoints, warnExpiringPoints } from '../modules/loyalty/lifecycle';
import { sendReviewPrompt } from '../modules/reviews/service';
import { expireReservation, reconcileAttempt } from '../modules/payments/service';
import { processStockAlerts } from '../modules/wishlist/service';
import type { JobWorker } from './worker';

export function registerJobHandlers(worker: JobWorker): void {
  worker.register('email.send', async (payload, ctx) => {
    await ctx.mailer.send(payload as EmailMessage);
  });
  worker.register('stock_alert.check', async (payload, ctx) => {
    await processStockAlerts(ctx, (payload as { skuId: string }).skuId);
  });
  worker.register('reservation.expire', async (payload, ctx) => {
    await expireReservation(ctx, (payload as { orderId: string }).orderId);
  });
  worker.register('payment.reconcile', async (payload, ctx) => {
    await reconcileAttempt(ctx, (payload as { attemptId: string }).attemptId);
  });
  worker.register('fulfilment.advance', async (payload, ctx) => {
    await advanceFulfilment(ctx, payload as Parameters<typeof advanceFulfilment>[1]);
  });
  worker.register('return.advance', async (payload, ctx) => {
    await advanceReturn(ctx, payload as Parameters<typeof advanceReturn>[1]);
  });
  worker.register('refund.process', async (payload, ctx) => {
    await processRefund(ctx, (payload as { refundId: string }).refundId);
  });
  worker.register('points.confirm', async (payload, ctx) => {
    await confirmOrderPoints(ctx, (payload as { orderId: string }).orderId);
  });
  worker.register('points.expire', async (payload, ctx) => {
    await expireDuePoints(ctx, (payload as { userId: string }).userId);
  });
  worker.register('points.expiry_warning', async (payload, ctx) => {
    const p = payload as { userId: string; on: string };
    await warnExpiringPoints(ctx, p.userId, p.on);
  });
  worker.register('review.prompt', async (payload, ctx) => {
    await sendReviewPrompt(ctx, (payload as { orderId: string }).orderId);
  });
  worker.register('price_drop.check', async (payload, ctx) => {
    await checkPriceDrop(ctx, (payload as { colorwayId: string }).colorwayId);
  });
  // Simulated gateway internals.
  worker.register('gateway.charge.settle', async (payload, ctx) => {
    await gateway.settleCharge(ctx, payload as Parameters<typeof gateway.settleCharge>[1]);
  });
  worker.register('gateway.webhook.deliver', async (payload, ctx) => {
    await gateway.deliverWebhook(ctx, payload as gateway.WebhookEvent);
  });
}
