import type { SessionUser, SignInInput, SignUpInput } from '@avero/shared';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { business } from '../../config/business';
import type { AppContext } from '../../context';
import type { DbOrTx } from '../../db/client';
import { authTokens, oauthAccounts, sessions, users } from '../../db/schema';
import { attachReferral } from '../referrals/service';
import { addDays, addHours, addMinutes } from '../../lib/clock';
import { randomCode, randomToken, sha256 } from '../../lib/crypto';
import { resetPasswordTemplate, verifyEmailTemplate } from '../../lib/email-templates';
import { AppError } from '../../lib/errors';
import { enqueue } from '../../jobs/queue';
import type { UserRow } from '../../plugins/session';

export interface ClientMeta {
  userAgent?: string;
  ip?: string;
}

// Used to keep sign-in timing similar whether or not the account exists.
const DUMMY_HASH = await hash('avero-timing-equaliser');

export function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    phone: user.phone,
    hasPassword: user.passwordHash !== null,
    preferredSize: user.preferredSize,
    referralCode: user.referralCode,
  };
}

async function generateReferralCode(db: DbOrTx): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = `AV${randomCode(6)}`;
    const taken = await db.query.users.findFirst({
      where: eq(users.referralCode, code),
      columns: { id: true },
    });
    if (!taken) return code;
  }
  throw new Error('Could not allocate a unique referral code');
}

export async function createSession(
  ctx: AppContext,
  db: DbOrTx,
  userId: string,
  meta: ClientMeta,
): Promise<string> {
  const token = randomToken();
  const now = ctx.clock.now();
  await db.insert(sessions).values({
    tokenHash: sha256(token),
    userId,
    expiresAt: addDays(now, business.auth.sessionTtlDays),
    lastSeenAt: now,
    userAgent: meta.userAgent?.slice(0, 300),
    ip: meta.ip,
  });
  return token;
}

async function issueVerificationEmail(ctx: AppContext, db: DbOrTx, user: UserRow): Promise<void> {
  const token = randomToken();
  await db.insert(authTokens).values({
    userId: user.id,
    purpose: 'verify_email',
    tokenHash: sha256(token),
    expiresAt: addHours(ctx.clock.now(), business.auth.verifyEmailTtlHours),
  });
  const link = `${ctx.env.WEB_ORIGIN}/verify-email?token=${token}`;
  await enqueue(db, 'email.send', verifyEmailTemplate(user.email, user.name, link));
}

export async function signUp(ctx: AppContext, input: SignUpInput, meta: ClientMeta) {
  const existing = await ctx.db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (existing) {
    throw new AppError(
      'EMAIL_TAKEN',
      existing.passwordHash
        ? 'An account with this email already exists. Sign in instead.'
        : 'This email is linked to Google sign-in. Continue with Google instead.',
    );
  }
  const passwordHash = await hash(input.password);

  return ctx.db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: input.email,
        name: input.name,
        phone: input.phone,
        passwordHash,
        referralCode: await generateReferralCode(tx),
      })
      .onConflictDoNothing()
      .returning();
    if (!user) throw new AppError('EMAIL_TAKEN', 'An account with this email already exists.');
    await attachReferral(ctx, tx, user, input.referralCode);
    await issueVerificationEmail(ctx, tx, user);
    const token = await createSession(ctx, tx, user.id, meta);
    return { user, token };
  });
}

export async function signIn(ctx: AppContext, input: SignInInput, meta: ClientMeta) {
  const user = await ctx.db.query.users.findFirst({ where: eq(users.email, input.email) });
  const ok = await verify(user?.passwordHash ?? DUMMY_HASH, input.password);
  if (!user || !user.passwordHash || !ok) {
    throw new AppError('INVALID_CREDENTIALS', 'Incorrect email or password');
  }
  const token = await createSession(ctx, ctx.db, user.id, meta);
  return { user, token };
}

export async function revokeSession(ctx: AppContext, sessionId: string): Promise<void> {
  await ctx.db
    .update(sessions)
    .set({ revokedAt: ctx.clock.now() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export async function revokeOtherSessions(ctx: AppContext, userId: string, keepSessionId: string) {
  await ctx.db
    .update(sessions)
    .set({ revokedAt: ctx.clock.now() })
    .where(
      and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId), isNull(sessions.revokedAt)),
    );
}

export async function listSessions(ctx: AppContext, userId: string, currentSessionId: string) {
  const rows = await ctx.db.query.sessions.findMany({
    where: and(
      eq(sessions.userId, userId),
      isNull(sessions.revokedAt),
      gt(sessions.expiresAt, ctx.clock.now()),
    ),
    orderBy: (s, { desc }) => desc(s.lastSeenAt),
  });
  return rows.map((s) => ({
    id: s.id,
    userAgent: s.userAgent,
    ip: s.ip,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    current: s.id === currentSessionId,
  }));
}

/** Atomically consumes a single-use token. Returns its user id. */
async function consumeToken(
  ctx: AppContext,
  db: DbOrTx,
  purpose: 'verify_email' | 'reset_password',
  token: string,
): Promise<string> {
  const now = ctx.clock.now();
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(authTokens.tokenHash, sha256(token)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning({ userId: authTokens.userId });
  if (!row) throw new AppError('TOKEN_INVALID', 'This link is invalid or has expired');
  return row.userId;
}

export async function verifyEmail(ctx: AppContext, token: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const userId = await consumeToken(ctx, tx, 'verify_email', token);
    await tx
      .update(users)
      .set({ emailVerifiedAt: ctx.clock.now() })
      .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
  });
}

export async function resendVerification(ctx: AppContext, user: UserRow): Promise<void> {
  if (user.emailVerifiedAt) return;
  await ctx.db.transaction((tx) => issueVerificationEmail(ctx, tx, user));
}

export async function requestPasswordReset(ctx: AppContext, email: string): Promise<void> {
  const user = await ctx.db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) return; // never reveal whether an account exists
  await ctx.db.transaction(async (tx) => {
    const token = randomToken();
    await tx.insert(authTokens).values({
      userId: user.id,
      purpose: 'reset_password',
      tokenHash: sha256(token),
      expiresAt: addMinutes(ctx.clock.now(), business.auth.resetPasswordTtlMinutes),
    });
    const link = `${ctx.env.WEB_ORIGIN}/reset-password?token=${token}`;
    await enqueue(tx, 'email.send', resetPasswordTemplate(user.email, user.name, link));
  });
}

/** Sets a new password, revokes every session, and (since the inbox was proven) verifies the email. */
export async function resetPassword(ctx: AppContext, token: string, password: string) {
  const passwordHash = await hash(password);
  await ctx.db.transaction(async (tx) => {
    const userId = await consumeToken(ctx, tx, 'reset_password', token);
    const now = ctx.clock.now();
    const [user] = await tx
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, userId))
      .returning();
    if (user && !user.emailVerifiedAt) {
      await tx.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, userId));
    }
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  });
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

/**
 * Resolves a Google identity to a user:
 * 1. known Google account → its user
 * 2. existing user with same email → link, but only if Google verified the email
 * 3. otherwise create a new (password-less) user
 */
export async function findOrCreateGoogleUser(ctx: AppContext, profile: GoogleProfile, referralCode?: string) {
  const email = profile.email.trim().toLowerCase();
  return ctx.db.transaction(async (tx) => {
    const linked = await tx.query.oauthAccounts.findFirst({
      where: and(
        eq(oauthAccounts.provider, 'google'),
        eq(oauthAccounts.providerAccountId, profile.sub),
      ),
    });
    if (linked) {
      const user = await tx.query.users.findFirst({ where: eq(users.id, linked.userId) });
      if (user) return user;
    }

    const now = ctx.clock.now();
    const existing = await tx.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) {
      if (!profile.emailVerified) {
        throw new AppError(
          'ACCOUNT_LINK_REQUIRED',
          'An account with this email exists. Sign in with your password to continue.',
        );
      }
      await tx
        .insert(oauthAccounts)
        .values({ userId: existing.id, provider: 'google', providerAccountId: profile.sub });
      if (!existing.emailVerifiedAt) {
        await tx.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, existing.id));
      }
      return existing;
    }

    const [user] = await tx
      .insert(users)
      .values({
        email,
        name: profile.name || email.split('@')[0]!,
        emailVerifiedAt: profile.emailVerified ? now : null,
        referralCode: await generateReferralCode(tx),
      })
      .returning();
    await tx
      .insert(oauthAccounts)
      .values({ userId: user!.id, provider: 'google', providerAccountId: profile.sub });
    // Only brand-new accounts can be referred (an existing member signing in with Google can't).
    await attachReferral(ctx, tx, user!, referralCode);
    return user!;
  });
}
