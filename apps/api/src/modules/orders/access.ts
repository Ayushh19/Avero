import type { FastifyRequest } from 'fastify';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import type { orders } from '../../db/schema';
import { addDays } from '../../lib/clock';
import { hmacSha256, safeEqual, sha256 } from '../../lib/crypto';
import { GUEST_COOKIE } from '../checkout/service';

type OrderRow = typeof orders.$inferSelect;

/**
 * Guest order links: `<expiry unix seconds>.<hmac>` bound to the order number, signed with the
 * session secret. Sent in emails and returned by the /track lookup.
 */
export function signOrderToken(ctx: AppContext, orderNumber: string): string {
  const exp = Math.floor(addDays(ctx.clock.now(), business.guestOrderLinkTtlDays).getTime() / 1000);
  return `${exp}.${hmacSha256(ctx.env.SESSION_SECRET, `order:${orderNumber}:${exp}`)}`;
}

export function verifyOrderToken(ctx: AppContext, orderNumber: string, token: string | undefined): boolean {
  if (!token) return false;
  const [expRaw, mac] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || !mac) return false;
  if (exp * 1000 < ctx.clock.now().getTime()) return false;
  return safeEqual(mac, hmacSha256(ctx.env.SESSION_SECRET, `order:${orderNumber}:${exp}`));
}

/** Owner (signed in), the guest device that placed it, or a valid signed link. */
export function canAccessOrder(ctx: AppContext, req: FastifyRequest, order: OrderRow, token?: string): boolean {
  if (req.user && order.userId === req.user.id) return true;
  const device = req.cookies[GUEST_COOKIE];
  if (device && order.guestTokenHash && safeEqual(sha256(device), order.guestTokenHash)) return true;
  return verifyOrderToken(ctx, order.orderNumber, token);
}

export function orderLink(ctx: AppContext, order: Pick<OrderRow, 'orderNumber' | 'userId'>): string {
  return order.userId
    ? `${ctx.env.WEB_ORIGIN}/account/orders/${order.orderNumber}`
    : `${ctx.env.WEB_ORIGIN}/orders/${order.orderNumber}?token=${signOrderToken(ctx, order.orderNumber)}`;
}
