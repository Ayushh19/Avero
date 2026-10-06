import { createHash } from 'node:crypto';
import type { Env } from '../../config/env';
import { randomToken } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import type { GoogleProfile } from './service';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface OAuthState {
  state: string;
  verifier: string;
  returnTo: string;
  /** Referral code from an invite link, applied if this creates a new account. */
  ref?: string;
}

export function createAuthorizationRequest(env: Env, returnTo: string, ref?: string) {
  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.GOOGLE_REDIRECT_URI!,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.toString(), cookie: { state, verifier, returnTo, ...(ref ? { ref } : {}) } satisfies OAuthState };
}

/** Exchanges the authorization code and fetches the user's profile from Google. */
export async function fetchGoogleProfile(
  env: Env,
  code: string,
  verifier: string,
): Promise<GoogleProfile> {
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: env.GOOGLE_REDIRECT_URI!,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new AppError('OAUTH_FAILED', 'Google sign-in failed. Please try again.');
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) throw new AppError('OAUTH_FAILED', 'Google sign-in failed. Please try again.');

  const infoRes = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!infoRes.ok) throw new AppError('OAUTH_FAILED', 'Could not read your Google profile.');
  const info = (await infoRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
  if (!info.sub || !info.email) {
    throw new AppError('OAUTH_FAILED', 'Your Google account did not share an email address.');
  }
  return {
    sub: info.sub,
    email: info.email,
    emailVerified: info.email_verified === true,
    name: info.name ?? '',
  };
}

/** Only allow same-site relative paths as post-login destinations. */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/';
}
