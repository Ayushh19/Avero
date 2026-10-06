import { forgotPasswordSchema, resetPasswordSchema, signInSchema, signUpSchema } from '@avero/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MailCheck } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { Button, ButtonLink } from '../../components/ui/Button';
import { ErrorState } from '../../components/ui/Feedback';
import { Field, FormError } from '../../components/ui/Form';
import { ProductMedia } from '../../components/ui/Merch';
import { api, errorMessage, fieldErrors } from '../../lib/api';
import { googleSignInUrl, meQueryKey, useMe, usePublicConfig, useSignIn, useSignUp } from './hooks';
import styles from './pages.module.css';

const OAUTH_ERRORS: Record<string, string> = {
  google_cancelled: 'Google sign-in was cancelled.',
  oauth_state: 'Your sign-in session expired. Please try again.',
  account_link_required:
    'An account with this email already exists. Sign in with your password to continue.',
  oauth_failed: 'Google sign-in failed. Please try again.',
};

/** Validates a form with a shared Zod schema, returning field errors keyed by path. */
function validate<S extends z.ZodType>(schema: S, form: HTMLFormElement) {
  const raw = Object.fromEntries(
    [...new FormData(form)].filter(([, v]) => v !== '').map(([k, v]) => [k, String(v)]),
  );
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { data: parsed.data as z.infer<S>, errors: {} };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) errors[issue.path.join('.')] ??= issue.message;
  return { data: null, errors };
}

function useReturnTo() {
  const [params] = useSearchParams();
  const value = params.get('returnTo');
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/account';
}

function AuthLayout({ eyebrow, title, intro, children }: { eyebrow?: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <main className={`container ${styles.layout}`}>
      <div className={styles.formCol}>
        <div className={styles.head}>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h1>{title}</h1>
          {intro ? <p className={styles.intro}>{intro}</p> : null}
        </div>
        {children}
      </div>
      <aside className={styles.visual} aria-hidden>
        <ProductMedia alt="" ratio="4/5" tone="sage" radius="xl" />
        <p className={styles.visualCaption}>Members get early access to drops, order tracking in one place, and AVERO Rewards on every purchase.</p>
      </aside>
    </main>
  );
}

function GoogleButton({ returnTo, referralCode }: { returnTo: string; referralCode?: string }) {
  const { data: config } = usePublicConfig();
  if (!config?.auth.googleEnabled) return null;
  return (
    <>
      <a className={styles.google} href={googleSignInUrl(returnTo, referralCode)}>
        <GoogleMark />
        Continue with Google
      </a>
      <p className={styles.divider}>
        <span>or</span>
      </p>
    </>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.5 2.2-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

export function SignInPage() {
  const returnTo = useReturnTo();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const signIn = useSignIn();
  const { data: user } = useMe();
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (user) return <Navigate to={returnTo} replace />;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { data, errors } = validate(signInSchema, e.currentTarget);
    setErrors(errors);
    if (data) signIn.mutate(data, { onSuccess: () => navigate(returnTo, { replace: true }) });
  };

  const oauthError = params.get('error');
  const all = { ...errors, ...fieldErrors(signIn.error) };
  return (
    <AuthLayout eyebrow="Welcome back" title="Sign in to AVERO">
      <FormError message={oauthError ? (OAUTH_ERRORS[oauthError] ?? OAUTH_ERRORS.oauth_failed) : null} />
      <GoogleButton returnTo={returnTo} />
      <form onSubmit={onSubmit} noValidate className={styles.form}>
        <Field label="Email" name="email" type="email" autoComplete="email" error={all.email} />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          error={all.password}
          labelAction={
            <Link to="/forgot-password" className={styles.smallLink}>
              Forgot password?
            </Link>
          }
        />
        <FormError message={signIn.error && !Object.keys(all).length ? errorMessage(signIn.error) : null} />
        <Button type="submit" size="lg" fullWidth loading={signIn.isPending}>
          Sign in
        </Button>
      </form>
      <p className={styles.alt}>
        New to AVERO? <Link to={`/signup?returnTo=${encodeURIComponent(returnTo)}`}>Create an account</Link>
      </p>
    </AuthLayout>
  );
}

export function SignUpPage() {
  const returnTo = useReturnTo();
  const navigate = useNavigate();
  const signUp = useSignUp();
  const { data: user } = useMe();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [params] = useSearchParams();
  const referralCode = params.get('ref') ?? undefined;

  if (user) return <Navigate to={returnTo} replace />;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { data, errors } = validate(signUpSchema, e.currentTarget);
    setErrors(errors);
    if (data) signUp.mutate(data, { onSuccess: () => navigate(returnTo, { replace: true }) });
  };

  const all = { ...errors, ...fieldErrors(signUp.error) };
  return (
    <AuthLayout
      eyebrow="Join AVERO"
      title="Create your account"
      intro="Track orders, save your favourites and earn rewards. Checking out as a guest is always an option too."
    >
      <GoogleButton returnTo={returnTo} referralCode={referralCode} />
      <form onSubmit={onSubmit} noValidate className={styles.form}>
        <Field label="Full name" name="name" autoComplete="name" error={all.name} />
        <Field label="Email" name="email" type="email" autoComplete="email" defaultValue={params.get('email') ?? undefined} error={all.email} />
        <Field
          label="Mobile number (optional)"
          name="phone"
          type="tel"
          autoComplete="tel-national"
          inputMode="numeric"
          error={all.phone}
          hint="10-digit Indian mobile number, for delivery updates"
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          error={all.password}
          hint="At least 8 characters, with a letter and a number"
        />
        {referralCode ? <input type="hidden" name="referralCode" value={referralCode} /> : null}
        <FormError message={signUp.error && !Object.keys(all).length ? errorMessage(signUp.error) : null} />
        <Button type="submit" size="lg" fullWidth loading={signUp.isPending}>
          Create account
        </Button>
      </form>
      <p className={styles.alt}>
        Already have an account? <Link to={`/signin?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</Link>
      </p>
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const qc = useQueryClient();
  const verify = useMutation({
    mutationFn: () => api.post('/auth/verify-email', { token }),
    onSuccess: () => qc.invalidateQueries({ queryKey: meQueryKey }),
  });
  const started = useRef(false);

  useEffect(() => {
    // Guard against StrictMode double-invocation consuming the single-use token twice.
    if (started.current || !token) return;
    started.current = true;
    verify.mutate();
  }, [token, verify]);

  if (!token || verify.isError) {
    return (
      <main className="container">
        <ErrorState
          title="This link can't be used"
          error={verify.error ?? undefined}
          action={<ButtonLink to="/account">Request a new link</ButtonLink>}
        />
      </main>
    );
  }

  return (
    <main className={`container ${styles.status}`} role="status" aria-live="polite">
      {verify.isSuccess ? (
        <>
          <CheckCircle2 size={40} strokeWidth={1.4} className={styles.successIcon} aria-hidden />
          <h1>Email verified</h1>
          <p className={styles.intro}>Thanks for confirming. Your account is all set.</p>
          <ButtonLink to="/">Continue shopping</ButtonLink>
        </>
      ) : (
        <>
          <h1>Verifying your email…</h1>
          <p className={styles.intro}>This only takes a moment.</p>
        </>
      )}
    </main>
  );
}

export function ForgotPasswordPage() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const request = useMutation({
    mutationFn: (email: string) => api.post('/auth/forgot-password', { email }),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { data, errors } = validate(forgotPasswordSchema, e.currentTarget);
    setErrors(errors);
    if (data) request.mutate(data.email);
  };

  if (request.isSuccess) {
    return (
      <main className={`container ${styles.status}`} role="status">
        <MailCheck size={40} strokeWidth={1.4} aria-hidden />
        <h1>Check your inbox</h1>
        <p className={styles.intro}>If an account exists for that email, we've sent a reset link. It expires in 30 minutes.</p>
        <ButtonLink to="/signin" variant="secondary">
          Back to sign in
        </ButtonLink>
      </main>
    );
  }

  return (
    <AuthLayout title="Reset your password" intro="Enter the email you use for AVERO and we'll send you a link to choose a new password.">
      <form onSubmit={onSubmit} noValidate className={styles.form}>
        <Field label="Email" name="email" type="email" autoComplete="email" error={errors.email} />
        <FormError message={request.error ? errorMessage(request.error) : null} />
        <Button type="submit" size="lg" fullWidth loading={request.isPending}>
          Send reset link
        </Button>
      </form>
      <p className={styles.alt}>
        <Link to="/signin">Back to sign in</Link>
      </p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [errors, setErrors] = useState<Record<string, string>>({});
  const reset = useMutation({
    mutationFn: (password: string) => api.post('/auth/reset-password', { token, password }),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { data, errors } = validate(resetPasswordSchema, e.currentTarget);
    setErrors(errors);
    if (data) reset.mutate(data.password);
  };

  if (reset.isSuccess) {
    return (
      <main className={`container ${styles.status}`} role="status">
        <CheckCircle2 size={40} strokeWidth={1.4} className={styles.successIcon} aria-hidden />
        <h1>Password updated</h1>
        <p className={styles.intro}>For your security, you've been signed out on all devices.</p>
        <ButtonLink to="/signin">Sign in with your new password</ButtonLink>
      </main>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      <form onSubmit={onSubmit} noValidate className={styles.form}>
        <input type="hidden" name="token" value={token} />
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          error={errors.password}
          hint="At least 8 characters, with a letter and a number"
        />
        <FormError message={reset.error ? errorMessage(reset.error) : errors.token ? 'This reset link is incomplete. Request a new one.' : null} />
        <Button type="submit" size="lg" fullWidth loading={reset.isPending}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}
