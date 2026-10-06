import {
  PAYMENT_SCENARIOS,
  type GatewayChargeDto,
  type PaymentMethod,
  type PaymentScenario,
} from '@avero/shared';
import { eq } from 'drizzle-orm';
import { business } from '../../../config/business';
import type { AppContext } from '../../../context';
import type { DbOrTx, Tx } from '../../../db/client';
import { gatewaySimCharges, gatewaySimRefunds, gatewaySimSettings } from '../../../db/schema';
import { enqueue } from '../../../jobs/queue';
import { hmacSha256, randomToken } from '../../../lib/crypto';
import { AppError } from '../../../lib/errors';

/**
 * A stand-in for a hosted third-party payment gateway. It owns its own state
 * (`gateway_sim_charges`) and reports outcomes to the merchant (our payments module) only via
 * HMAC-signed webhooks delivered by background jobs, or when the merchant asks during
 * reconciliation. Nothing here touches orders or payment attempts directly.
 */

type ChargeRow = typeof gatewaySimCharges.$inferSelect;
export type ChargeStatus = ChargeRow['status'];
export type WebhookType = 'payment.pending' | 'payment.succeeded' | 'payment.failed' | 'payment.cancelled';

export interface WebhookEvent {
  id: string;
  type: WebhookType;
  createdAt: string;
  data: { gatewayRef: string; merchantReference: string; amountPaise: number; failureReason?: string };
}

const seconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

export async function createCharge(
  ctx: AppContext,
  tx: Tx,
  input: { merchantReference: string; amountPaise: number; method: PaymentMethod; expiresAt: Date; lateAfter: Date | null },
): Promise<string> {
  const gatewayRef = `gw_${randomToken(12)}`;
  await tx.insert(gatewaySimCharges).values({ gatewayRef, ...input });
  return gatewayRef;
}

async function chargeByRef(db: DbOrTx, gatewayRef: string): Promise<ChargeRow> {
  const charge = await db.query.gatewaySimCharges.findFirst({ where: eq(gatewaySimCharges.gatewayRef, gatewayRef) });
  if (!charge) throw new AppError('NOT_FOUND', 'Payment session not found');
  return charge;
}

/** Status as the gateway reports it right now (an unsubmitted or never-settling charge expires). */
function effectiveStatus(ctx: AppContext, c: ChargeRow): ChargeStatus {
  const now = ctx.clock.now();
  if (c.status === 'created' && now >= c.expiresAt) return 'expired';
  if (c.status === 'processing' && c.resolveAt === null && now >= c.expiresAt) return 'expired';
  return c.status;
}

/** Data for the hosted payment page. */
export async function getChargePage(ctx: AppContext, gatewayRef: string): Promise<GatewayChargeDto> {
  const c = await chargeByRef(ctx.db, gatewayRef);
  return {
    gatewayRef: c.gatewayRef,
    merchant: 'AVERO',
    amountPaise: c.amountPaise,
    method: c.method,
    status: effectiveStatus(ctx, c),
    expiresAt: c.expiresAt.toISOString(),
    scenarios: PAYMENT_SCENARIOS,
  };
}

/**
 * The shopper "pays" on the gateway page; the chosen scenario decides what the gateway does next.
 * Returns where the browser should go (null = simulate a closed tab).
 */
export async function submitCharge(
  ctx: AppContext,
  gatewayRef: string,
  scenario: PaymentScenario,
  pendingResolution: 'success' | 'failure',
): Promise<{ redirectUrl: string | null }> {
  const p = business.payments;
  return ctx.db.transaction(async (tx) => {
    const [c] = await tx.select().from(gatewaySimCharges).where(eq(gatewaySimCharges.gatewayRef, gatewayRef)).for('update');
    if (!c) throw new AppError('NOT_FOUND', 'Payment session not found');
    if (effectiveStatus(ctx, c) !== 'created') {
      throw new AppError('CONFLICT', c.status === 'created' ? 'This payment session has expired' : 'This payment was already submitted');
    }
    const now = ctx.clock.now();
    const soon = seconds(now, p.webhookDelaySeconds);
    let set: Partial<typeof gatewaySimCharges.$inferInsert> = { status: 'processing', resolveAt: soon };
    const schedule: { at: Date; type?: WebhookType; settle?: ChargeStatus; failureReason?: string; deliveries?: number }[] = [];

    switch (scenario) {
      case 'success':
      case 'success_no_redirect':
        schedule.push({ at: soon, settle: 'succeeded' });
        break;
      case 'duplicate_webhook':
        schedule.push({ at: soon, settle: 'succeeded', deliveries: 3 });
        break;
      case 'failure_declined':
        schedule.push({ at: soon, settle: 'failed', failureReason: 'card_declined' });
        break;
      case 'failure_insufficient':
        schedule.push({ at: soon, settle: 'failed', failureReason: 'insufficient_funds' });
        break;
      case 'pending': {
        const resolveAt = seconds(now, p.pendingResolveSeconds);
        set = { status: 'processing', resolveAt };
        schedule.push({ at: soon, type: 'payment.pending' });
        schedule.push(
          pendingResolution === 'success'
            ? { at: resolveAt, settle: 'succeeded' }
            : { at: resolveAt, settle: 'failed', failureReason: 'bank_declined_after_pending' },
        );
        break;
      }
      case 'cancelled':
        set = { status: 'cancelled', resolveAt: now };
        await enqueueWebhook(tx, c, 'payment.cancelled', now, 1, 'user_cancelled');
        break;
      case 'timeout':
        // The bank never answers; the charge expires at the gateway and no webhook is sent.
        set = { status: 'processing', resolveAt: null };
        break;
      case 'late_success': {
        const after = c.lateAfter && c.lateAfter > now ? c.lateAfter : now;
        const resolveAt = seconds(after, p.lateSuccessAfterExpirySeconds);
        set = { status: 'processing', resolveAt };
        schedule.push({ at: resolveAt, settle: 'succeeded' });
        break;
      }
    }

    await tx
      .update(gatewaySimCharges)
      .set({ ...set, scenario, submittedAt: now })
      .where(eq(gatewaySimCharges.id, c.id));
    for (const s of schedule) {
      if (s.type) await enqueueWebhook(tx, c, s.type, s.at, 1);
      else await enqueue(tx, 'gateway.charge.settle', { gatewayRef, status: s.settle, failureReason: s.failureReason, deliveries: s.deliveries ?? 1 }, { runAt: s.at });
    }
    return { redirectUrl: scenario === 'success_no_redirect' ? null : `/checkout/processing/${c.merchantReference}` };
  });
}

/** Job: the bank answered. Settle the charge and notify the merchant. */
export async function settleCharge(
  ctx: AppContext,
  payload: { gatewayRef: string; status: ChargeStatus; failureReason?: string; deliveries: number },
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [c] = await tx.select().from(gatewaySimCharges).where(eq(gatewaySimCharges.gatewayRef, payload.gatewayRef)).for('update');
    if (!c || c.status !== 'processing') return;
    await tx
      .update(gatewaySimCharges)
      .set({ status: payload.status, failureReason: payload.failureReason ?? null, resolveAt: ctx.clock.now() })
      .where(eq(gatewaySimCharges.id, c.id));
    const type: WebhookType = payload.status === 'succeeded' ? 'payment.succeeded' : 'payment.failed';
    await enqueueWebhook(tx, c, type, ctx.clock.now(), payload.deliveries, payload.failureReason);
  });
}

/** Event ids are stable per (charge, type): a resend is the *same* event, as with real gateways. */
async function enqueueWebhook(tx: Tx, c: ChargeRow, type: WebhookType, at: Date, deliveries: number, failureReason?: string) {
  const event: WebhookEvent = {
    id: `evt_${c.gatewayRef}_${type.split('.')[1]}`,
    type,
    createdAt: at.toISOString(),
    data: { gatewayRef: c.gatewayRef, merchantReference: c.merchantReference, amountPaise: c.amountPaise, ...(failureReason ? { failureReason } : {}) },
  };
  for (let i = 0; i < deliveries; i++) {
    await enqueue(tx, 'gateway.webhook.deliver', event, { runAt: new Date(at.getTime() + i * 1000), maxAttempts: 8 });
  }
}

export function signWebhook(secret: string, body: string, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${hmacSha256(secret, `${timestampSeconds}.${body}`)}`;
}

/** Job: POST the event to the merchant's webhook endpoint. Non-2xx → throw → retried with backoff. */
export async function deliverWebhook(ctx: AppContext, event: WebhookEvent): Promise<void> {
  const body = JSON.stringify(event);
  const signature = signWebhook(ctx.env.PAYMENT_WEBHOOK_SECRET, body, Math.floor(ctx.clock.now().getTime() / 1000));
  const status = await ctx.webhookTransport(body, signature);
  if (status < 200 || status >= 300) throw new Error(`Webhook ${event.id} rejected with HTTP ${status}`);
}

/** Merchant-side reconciliation asks the gateway what happened to a charge. */
export async function queryCharge(ctx: AppContext, gatewayRef: string): Promise<{ status: ChargeStatus; failureReason: string | null; resolveAt: Date | null }> {
  const c = await chargeByRef(ctx.db, gatewayRef);
  return { status: effectiveStatus(ctx, c), failureReason: c.failureReason, resolveAt: c.resolveAt };
}

/** Merchant abandons a charge the shopper never submitted. False if it was already submitted. */
export async function voidCharge(ctx: AppContext, tx: Tx, gatewayRef: string): Promise<boolean> {
  const [c] = await tx.select().from(gatewaySimCharges).where(eq(gatewaySimCharges.gatewayRef, gatewayRef)).for('update');
  if (!c) return true;
  if (c.status === 'created') {
    await tx.update(gatewaySimCharges).set({ status: 'expired' }).where(eq(gatewaySimCharges.id, c.id));
    return true;
  }
  return effectiveStatus(ctx, c) === 'expired';
}

/** Merchant asks the gateway to resend the final event for a settled charge. */
export async function redeliverFinalEvent(ctx: AppContext, tx: Tx, gatewayRef: string): Promise<void> {
  const c = await chargeByRef(tx, gatewayRef);
  const type: WebhookType | null =
    c.status === 'succeeded' ? 'payment.succeeded' : c.status === 'failed' ? 'payment.failed' : c.status === 'cancelled' ? 'payment.cancelled' : null;
  if (type) await enqueueWebhook(tx, c, type, ctx.clock.now(), 1, c.failureReason ?? undefined);
}

/* ---------------- refunds ---------------- */

/**
 * Merchant asks the gateway to refund part of a capture. Idempotent per `requestKey` (a repeated
 * request gets the same answer). Fails while the dev failure counter is above zero.
 */
export async function requestRefund(
  ctx: AppContext,
  input: { requestKey: string; gatewayRef: string; amountPaise: number },
): Promise<{ status: 'succeeded' | 'failed'; failureReason: string | null }> {
  return ctx.db.transaction(async (tx) => {
    const seen = await tx.query.gatewaySimRefunds.findFirst({ where: eq(gatewaySimRefunds.requestKey, input.requestKey) });
    if (seen) return { status: seen.status, failureReason: seen.failureReason };
    await tx.insert(gatewaySimSettings).values({ id: 1 }).onConflictDoNothing();
    const [settings] = await tx.select().from(gatewaySimSettings).where(eq(gatewaySimSettings.id, 1)).for('update');
    const fail = (settings?.refundFailuresRemaining ?? 0) > 0;
    if (fail) {
      await tx
        .update(gatewaySimSettings)
        .set({ refundFailuresRemaining: settings!.refundFailuresRemaining - 1 })
        .where(eq(gatewaySimSettings.id, 1));
    }
    const status = fail ? ('failed' as const) : ('succeeded' as const);
    const failureReason = fail ? 'bank_unavailable' : null;
    await tx.insert(gatewaySimRefunds).values({ ...input, status, failureReason });
    return { status, failureReason };
  });
}

/** Dev: make the next `n` refund requests fail. */
export async function setRefundFailures(ctx: AppContext, n: number): Promise<number> {
  await ctx.db
    .insert(gatewaySimSettings)
    .values({ id: 1, refundFailuresRemaining: n })
    .onConflictDoUpdate({ target: gatewaySimSettings.id, set: { refundFailuresRemaining: n } });
  return n;
}
