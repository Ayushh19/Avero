import type { FastifyRequest } from 'fastify';
import { CART_COOKIE } from '../modules/cart/service';
import { sha256 } from './crypto';

/**
 * Stable identity for idempotency scopes: the signed-in user, else the guest's bag cookie.
 * Keys from different shoppers never collide.
 */
export function requesterScope(req: FastifyRequest): string {
  if (req.user) return `user:${req.user.id}`;
  return `guest:${sha256(req.cookies[CART_COOKIE] ?? req.ip)}`;
}
