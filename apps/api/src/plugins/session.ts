import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { business } from '../config/business';
import { sessions, users } from '../db/schema';
import { addDays, addMinutes } from '../lib/clock';
import { sha256 } from '../lib/crypto';
import { AppError, unauthenticated } from '../lib/errors';

export const SESSION_COOKIE = 'avero_session';

export type UserRow = typeof users.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    sessionId: string | null;
  }
}

/** CSRF guard: state-changing requests must be JSON and carry the X-Requested-With header. */
const CSRF_EXEMPT = new Set(['/api/v1/payments/webhook']);

export function registerSession(app: FastifyInstance): void {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  app.addHook('onRequest', async (request) => {
    const method = request.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const path = request.url.split('?')[0]!;
      if (!CSRF_EXEMPT.has(path) && request.headers['x-requested-with'] !== 'avero') {
        throw new AppError('FORBIDDEN', 'Missing X-Requested-With header');
      }
    }

    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;

    const { db, clock } = app.ctx;
    const now = clock.now();
    const [row] = await db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, sha256(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      )
      .limit(1);
    if (!row) return;

    request.user = row.user;
    request.sessionId = row.session.id;

    // Sliding expiry, written at most once per touch interval to avoid a write per request.
    if (addMinutes(row.session.lastSeenAt, business.auth.sessionTouchIntervalMinutes) < now) {
      await db
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt: addDays(now, business.auth.sessionTtlDays) })
        .where(eq(sessions.id, row.session.id));
    }
  });
}

export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: app.ctx.env.NODE_ENV === 'production',
    maxAge: business.auth.sessionTtlDays * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function requireUser(request: FastifyRequest): UserRow {
  if (!request.user) throw unauthenticated();
  return request.user;
}
