import { desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sentEmails } from '../src/db/schema';
import { api, client, createTestApp } from './helpers';

const alice = { name: 'Alice', email: 'Alice@Example.com', password: 'sneakers123', phone: '98765 43210' };

async function latestEmailToken(app: FastifyInstance): Promise<string> {
  await app.worker.runDue();
  const [mail] = await app.ctx.db.select().from(sentEmails).orderBy(desc(sentEmails.createdAt)).limit(1);
  const token = mail?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error('No token email found');
  return token;
}

describe('auth', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(() => app.close());

  it('signs up, normalises input, and starts a session', async () => {
    const c = client(app);
    const res = await c.post(api('/auth/signup'), alice);
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({
      email: 'alice@example.com',
      phone: '+919876543210',
      emailVerified: false,
      hasPassword: true,
    });
    expect(res.json().user.referralCode).toMatch(/^AV[0-9A-Z]{6}$/);

    const me = await c.get(api('/auth/me'));
    expect(me.json().user.email).toBe('alice@example.com');
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const c = client(app);
    await c.post(api('/auth/signup'), alice);
    const dup = await client(app).post(api('/auth/signup'), { ...alice, email: 'alice@example.com' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('EMAIL_TAKEN');

    const weak = await client(app).post(api('/auth/signup'), { ...alice, email: 'b@x.com', password: 'short' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('requires the CSRF header on mutations', async () => {
    const res = await app.inject({ method: 'POST', url: api('/auth/signup'), payload: alice });
    expect(res.statusCode).toBe(403);
  });

  it('signs in with correct credentials only, and signs out', async () => {
    await client(app).post(api('/auth/signup'), alice);

    const bad = await client(app).post(api('/auth/signin'), { email: alice.email, password: 'wrong-pass1' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('INVALID_CREDENTIALS');

    const c = client(app);
    const ok = await c.post(api('/auth/signin'), { email: alice.email, password: alice.password });
    expect(ok.statusCode).toBe(200);
    expect((await c.get(api('/auth/me'))).json().user).not.toBeNull();

    await c.post(api('/auth/signout'));
    expect((await c.get(api('/auth/me'))).json().user).toBeNull();
  });

  it('verifies email with a single-use token sent via the job queue', async () => {
    const c = client(app);
    await c.post(api('/auth/signup'), alice);
    const token = await latestEmailToken(app);

    expect((await c.post(api('/auth/verify-email'), { token })).statusCode).toBe(200);
    expect((await c.get(api('/auth/me'))).json().user.emailVerified).toBe(true);

    const reuse = await c.post(api('/auth/verify-email'), { token });
    expect(reuse.json().error.code).toBe('TOKEN_INVALID');
  });

  it('resets password and revokes all existing sessions', async () => {
    const device1 = client(app);
    await device1.post(api('/auth/signup'), alice);

    const forgot = await client(app).post(api('/auth/forgot-password'), { email: alice.email });
    expect(forgot.statusCode).toBe(200);
    const token = await latestEmailToken(app);

    const reset = await client(app).post(api('/auth/reset-password'), { token, password: 'newpass456' });
    expect(reset.statusCode).toBe(200);

    expect((await device1.get(api('/auth/me'))).json().user).toBeNull();
    const old = await client(app).post(api('/auth/signin'), { email: alice.email, password: alice.password });
    expect(old.statusCode).toBe(401);
    const fresh = await client(app).post(api('/auth/signin'), { email: alice.email, password: 'newpass456' });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().user.emailVerified).toBe(true);
  });

  it('does not reveal whether an email is registered on forgot-password', async () => {
    const res = await client(app).post(api('/auth/forgot-password'), { email: 'nobody@example.com' });
    expect(res.statusCode).toBe(200);
  });

  it('lists sessions and signs out other devices', async () => {
    const d1 = client(app);
    const d2 = client(app);
    await d1.post(api('/auth/signup'), alice);
    await d2.post(api('/auth/signin'), { email: alice.email, password: alice.password });

    const list = await d1.get(api('/auth/sessions'));
    expect(list.json().sessions).toHaveLength(2);

    expect((await d1.delete(api('/auth/sessions'))).statusCode).toBe(204);
    expect((await d2.get(api('/auth/me'))).json().user).toBeNull();
    expect((await d1.get(api('/auth/me'))).json().user).not.toBeNull();
  });

  it('links a referral code at sign-up', async () => {
    const referrer = await client(app).post(api('/auth/signup'), alice);
    const code = referrer.json().user.referralCode;
    const res = await client(app).post(api('/auth/signup'), {
      name: 'Bob',
      email: 'bob@example.com',
      password: 'running123',
      referralCode: code.toLowerCase(),
    });
    expect(res.statusCode).toBe(201);
    const referral = await app.ctx.db.query.referrals.findFirst();
    expect(referral?.status).toBe('signed_up');
  });

  it('reports Google sign-in as unavailable without credentials', async () => {
    const res = await client(app).get(api('/auth/google/start'));
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('GOOGLE_NOT_CONFIGURED');
  });
});
