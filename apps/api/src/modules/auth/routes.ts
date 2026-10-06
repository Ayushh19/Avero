import {
  forgotPasswordSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  tokenSchema,
  type MeResponse,
} from '@avero/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { googleCallbackPath, googleEnabled } from '../../config/env';
import { AppError } from '../../lib/errors';
import {
  clearSessionCookie,
  requireUser,
  setSessionCookie,
} from '../../plugins/session';
import { createAuthorizationRequest, fetchGoogleProfile, safeReturnTo, type OAuthState } from './google';
import * as auth from './service';
import { CART_COOKIE, mergeGuestCart } from '../cart/service';

const OAUTH_COOKIE = 'avero_oauth';
const authRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/** Folds the device's guest bag into the account and forgets the guest token. */
async function mergeBag(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, userId: string): Promise<number> {
  const merged = await mergeGuestCart(app.ctx, req.cookies[CART_COOKIE], userId);
  if (req.cookies[CART_COOKIE]) reply.clearCookie(CART_COOKIE, { path: '/' });
  return merged;
}

const meta = (req: FastifyRequest): auth.ClientMeta => ({
  userAgent: req.headers['user-agent'],
  ip: req.ip,
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/auth/me', async (req): Promise<MeResponse> => ({
    user: req.user ? auth.toSessionUser(req.user) : null,
  }));

  app.post('/auth/signup', { config: authRateLimit }, async (req, reply) => {
    const input = signUpSchema.parse(req.body);
    const { user, token } = await auth.signUp(ctx, input, meta(req));
    setSessionCookie(app, reply, token);
    const mergedBagLines = await mergeBag(app, req, reply, user.id);
    return reply.status(201).send({ user: auth.toSessionUser(user), mergedBagLines });
  });

  app.post('/auth/signin', { config: authRateLimit }, async (req, reply) => {
    const input = signInSchema.parse(req.body);
    const { user, token } = await auth.signIn(ctx, input, meta(req));
    setSessionCookie(app, reply, token);
    const mergedBagLines = await mergeBag(app, req, reply, user.id);
    return { user: auth.toSessionUser(user), mergedBagLines };
  });

  app.post('/auth/signout', async (req, reply) => {
    if (req.sessionId) await auth.revokeSession(ctx, req.sessionId);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.post('/auth/verify-email', { config: authRateLimit }, async (req) => {
    const { token } = tokenSchema.parse(req.body);
    await auth.verifyEmail(ctx, token);
    return { ok: true };
  });

  app.post('/auth/resend-verification', { config: authRateLimit }, async (req) => {
    await auth.resendVerification(ctx, requireUser(req));
    return { ok: true };
  });

  app.post('/auth/forgot-password', { config: authRateLimit }, async (req) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    await auth.requestPasswordReset(ctx, email);
    return { ok: true };
  });

  app.post('/auth/reset-password', { config: authRateLimit }, async (req, reply) => {
    const { token, password } = resetPasswordSchema.parse(req.body);
    await auth.resetPassword(ctx, token, password);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/sessions', async (req) => {
    const user = requireUser(req);
    return { sessions: await auth.listSessions(ctx, user.id, req.sessionId!) };
  });

  app.delete('/auth/sessions', async (req, reply) => {
    const user = requireUser(req);
    await auth.revokeOtherSessions(ctx, user.id, req.sessionId!);
    return reply.status(204).send();
  });

  app.delete('/auth/sessions/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const sessions = await auth.listSessions(ctx, user.id, req.sessionId!);
    if (!sessions.some((s) => s.id === id)) throw new AppError('NOT_FOUND', 'Session not found');
    await auth.revokeSession(ctx, id);
    if (id === req.sessionId) clearSessionCookie(reply);
    return reply.status(204).send();
  });

  // --- Google sign-in -------------------------------------------------------

  app.get('/auth/google/start', async (req, reply) => {
    if (!googleEnabled(ctx.env)) {
      throw new AppError('GOOGLE_NOT_CONFIGURED', 'Google sign-in is not available');
    }
    const { returnTo, ref } = z
      .object({ returnTo: z.string().optional(), ref: z.string().trim().regex(/^[A-Za-z0-9]{4,20}$/).optional() })
      .parse(req.query);
    const { url, cookie } = createAuthorizationRequest(ctx.env, safeReturnTo(returnTo), ref);
    // Path `/`: the callback may be served anywhere on the API (wherever GOOGLE_REDIRECT_URI points).
    reply.setCookie(OAUTH_COOKIE, JSON.stringify(cookie), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.env.NODE_ENV === 'production',
      signed: true,
      maxAge: 10 * 60,
    });
    return reply.redirect(url);
  });

  app.get('/auth/google/callback', googleCallbackHandler(app));
}

/**
 * Google's redirect target. Also mounted at the path of GOOGLE_REDIRECT_URI when that isn't the
 * default (see `registerGoogleCallbackAlias`).
 */
export function googleCallbackHandler(app: FastifyInstance) {
  const { ctx } = app;
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const web = ctx.env.WEB_ORIGIN;
    const fail = (code: string) => reply.redirect(`${web}/signin?error=${code}`);

    const query = z
      .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() })
      .parse(req.query);
    const raw = req.cookies[OAUTH_COOKIE];
    reply.clearCookie(OAUTH_COOKIE, { path: '/' });
    if (query.error) return fail('google_cancelled');

    const unsigned = raw ? req.unsignCookie(raw) : undefined;
    let saved: OAuthState | undefined;
    try {
      saved = unsigned?.valid && unsigned.value ? (JSON.parse(unsigned.value) as OAuthState) : undefined;
    } catch {
      saved = undefined;
    }
    if (!saved || !query.code || query.state !== saved.state) return fail('oauth_state');

    try {
      const profile = await fetchGoogleProfile(ctx.env, query.code, saved.verifier);
      const user = await auth.findOrCreateGoogleUser(ctx, profile, saved.ref);
      const token = await auth.createSession(ctx, ctx.db, user.id, meta(req));
      setSessionCookie(app, reply, token);
      await mergeBag(app, req, reply, user.id);
      return reply.redirect(`${web}${safeReturnTo(saved.returnTo)}`);
    } catch (err) {
      if (err instanceof AppError) return fail(err.code.toLowerCase());
      req.log.error({ err }, 'google sign-in failed');
      return fail('oauth_failed');
    }
  };
}

/**
 * Serves the Google callback at the path GOOGLE_REDIRECT_URI names (e.g. `/` for
 * `http://localhost:3000`) when it differs from `/api/v1/auth/google/callback`. Registered at the
 * app root, outside the `/api/v1` prefix. A plain visit without OAuth parameters goes to the store.
 */
export function registerGoogleCallbackAlias(app: FastifyInstance): void {
  const path = googleEnabled(app.ctx.env) ? googleCallbackPath(app.ctx.env) : null;
  if (!path || path === '/api/v1/auth/google/callback') return;
  const handle = googleCallbackHandler(app);
  app.get(path, async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    if (!q.code && !q.error && !q.state) return reply.redirect(app.ctx.env.WEB_ORIGIN);
    return handle(req, reply);
  });
}
