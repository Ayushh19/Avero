import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { openDatabase } from '../src/db/client';
import { api, client, testEnv } from './helpers';

/** Google sign-in with the redirect URI registered as the bare API origin (`http://localhost:3000`). */
const env = {
  ...testEnv,
  API_ORIGIN: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000',
};

let app: FastifyInstance;

beforeAll(async () => {
  const database = await openDatabase('memory');
  app = await buildApp({ env, database });
  app.addHook('onClose', () => database.close());
  await app.ready();
});
afterAll(() => app.close());
afterEach(() => vi.unstubAllGlobals());

/** Google's token + userinfo endpoints. */
function stubGoogle(profile: { sub: string; email: string; email_verified: boolean; name: string }) {
  const calls: { url: string; body?: string }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: { body?: URLSearchParams }) => {
    calls.push({ url, body: init?.body?.toString() });
    if (url.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'access-123' });
    if (url.includes('openidconnect.googleapis.com/v1/userinfo')) return Response.json(profile);
    return new Response('unexpected', { status: 500 });
  });
  return calls;
}

describe('Google sign-in with GOOGLE_REDIRECT_URI = http://localhost:3000', () => {
  it('sends Google the configured redirect URI and completes sign-in at /', async () => {
    const c = client(app);
    const start = await c.get(api('/auth/google/start?returnTo=/account/orders'));
    expect(start.statusCode).toBe(302);
    const google = new URL(start.headers.location as string);
    expect(google.origin).toBe('https://accounts.google.com');
    expect(google.searchParams.get('redirect_uri')).toBe('http://localhost:3000');
    const oauthCookie = start.cookies.find((ck) => ck.name === 'avero_oauth');
    expect(oauthCookie?.path).toBe('/');

    const calls = stubGoogle({ sub: 'g-1', email: 'riya.google@example.com', email_verified: true, name: 'Riya G' });
    const back = await c.get(`/?code=auth-code&state=${google.searchParams.get('state')}&scope=openid`);
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(`${env.WEB_ORIGIN}/account/orders`);
    // The token exchange repeats the same redirect URI, as Google requires.
    expect(new URLSearchParams(calls[0]!.body).get('redirect_uri')).toBe('http://localhost:3000');

    const me = (await c.get(api('/auth/me'))).json();
    expect(me.user).toMatchObject({ email: 'riya.google@example.com', name: 'Riya G', emailVerified: true });
  });

  it('rejects a mismatched state, and a plain visit to / goes to the store', async () => {
    const c = client(app);
    await c.get(api('/auth/google/start'));
    const bad = await c.get('/?code=x&state=forged');
    expect(bad.headers.location).toBe(`${env.WEB_ORIGIN}/signin?error=oauth_state`);
    const plain = await client(app).get('/');
    expect(plain.statusCode).toBe(302);
    expect(plain.headers.location).toBe(env.WEB_ORIGIN);
  });

  it('the default callback path keeps working', async () => {
    const c = client(app);
    const start = await c.get(api('/auth/google/start'));
    const state = new URL(start.headers.location as string).searchParams.get('state');
    stubGoogle({ sub: 'g-2', email: 'kabir.google@example.com', email_verified: true, name: 'Kabir G' });
    const back = await c.get(api(`/auth/google/callback?code=c&state=${state}`));
    expect(back.headers.location).toBe(`${env.WEB_ORIGIN}/`);
  });

  it('a referral code survives the Google round trip for new accounts', async () => {
    const referrer = client(app);
    const code = (
      await referrer.request({
        method: 'POST',
        url: api('/auth/signup'),
        payload: { name: 'Meera Nair', email: 'meera.g@example.com', password: 'sneakers123', phone: '9811112222' },
      })
    ).json().user.referralCode;
    const c = client(app);
    const start = await c.get(api(`/auth/google/start?returnTo=/&ref=${code}`));
    const state = new URL(start.headers.location as string).searchParams.get('state');
    stubGoogle({ sub: 'g-ref', email: 'arjun.g@example.com', email_verified: true, name: 'Arjun Das' });
    await c.get(`/?code=c&state=${state}`);
    const me = (await c.get(api('/auth/me'))).json().user;
    const ref = await app.ctx.db.query.referrals.findFirst({ where: (r, { eq }) => eq(r.refereeUserId, me.id) });
    expect(ref?.status).toBe('signed_up');
    const offer = await app.ctx.db.query.coupons.findFirst({ where: (cp, { eq }) => eq(cp.restrictedToUserId, me.id) });
    expect(offer?.value).toBe(250_00);
  });

  it('refuses a redirect URI that does not point at the API', () => {
    const raw = {
      SESSION_SECRET: 'test-session-secret-that-is-long-enough-000',
      PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret',
      API_ORIGIN: 'http://localhost:3000',
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
    };
    expect(loadEnv({ ...raw, GOOGLE_REDIRECT_URI: 'http://localhost:3000' }).GOOGLE_REDIRECT_URI).toBe('http://localhost:3000');
    expect(() => loadEnv({ ...raw, GOOGLE_REDIRECT_URI: 'http://localhost:5173' })).toThrow(/must point at the API/);
    expect(() => loadEnv({ ...raw, GOOGLE_REDIRECT_URI: 'not a url' })).toThrow(/must be a full URL/);
  });
});
