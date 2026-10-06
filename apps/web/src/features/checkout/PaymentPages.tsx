import {
  formatINR,
  type GatewayChargeDto,
  type GatewaySubmitResponse,
  type PaymentAttemptStatusDto,
  type PaymentMethod,
  type PaymentScenario,
} from '@avero/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, CreditCard, Hourglass, Landmark, LoaderCircle, PackageX, Smartphone, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Commerce';
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '../../components/ui/Feedback';
import { Field, FormError, RadioCard, SelectField } from '../../components/ui/Form';
import { api, errorMessage } from '../../lib/api';
import { cx } from '../../lib/cx';
import { cartKey } from '../bag/hooks';
import { failureText } from '../orders/hooks';
import { useAttemptStatus, useStartPayment } from './hooks';
import styles from './Payment.module.css';

/* ---------------- shared ---------------- */

function useCountdown(to: string | null | undefined): { text: string; over: boolean } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (!to) return { text: '', over: false };
  const left = Math.max(0, Math.floor((new Date(to).getTime() - now) / 1000));
  return { text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, over: left === 0 };
}

/* ---------------- gateway page: /checkout/pay/:attemptId ---------------- */

const SCENARIOS: { value: PaymentScenario; title: string; description: string }[] = [
  { value: 'success', title: 'Payment succeeds', description: 'Approved straight away' },
  { value: 'failure_declined', title: 'Declined', description: 'The bank declines the payment' },
  { value: 'failure_insufficient', title: 'Insufficient funds', description: 'The payment fails for lack of funds' },
  { value: 'pending', title: 'Pending', description: 'The bank takes about 30 seconds to decide' },
  { value: 'timeout', title: 'No response', description: 'The bank never answers; the attempt times out' },
  { value: 'success_no_redirect', title: 'Succeeds, tab closed', description: 'Paid, but you never come back to AVERO' },
  { value: 'duplicate_webhook', title: 'Duplicate notifications', description: 'Paid; the gateway notifies AVERO three times' },
  { value: 'late_success', title: 'Late success', description: 'Paid only after your 15-minute reservation ends' },
];

const METHOD_TABS: { value: PaymentMethod; title: string; icon: typeof Smartphone }[] = [
  { value: 'upi', title: 'UPI', icon: Smartphone },
  { value: 'card', title: 'Card', icon: CreditCard },
  { value: 'netbanking', title: 'Net banking', icon: Landmark },
];

const BANKS = ['HDFC Bank', 'ICICI Bank', 'State Bank of India', 'Axis Bank', 'Kotak Mahindra Bank'];

/** Luhn check, client-side only: card details are never sent anywhere. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return digits.length >= 12 && sum % 10 === 0;
}

function validateMethod(method: PaymentMethod, form: FormData): Record<string, string> {
  const errors: Record<string, string> = {};
  if (method === 'upi') {
    if (!/^[\w.-]{2,}@[a-z]{2,}$/i.test(String(form.get('vpa') ?? '').trim())) errors.vpa = 'Enter a UPI ID like name@okhdfc';
  } else if (method === 'card') {
    const number = String(form.get('cardNumber') ?? '').replace(/\s/g, '');
    if (!/^\d{12,19}$/.test(number) || !luhn(number)) errors.cardNumber = 'Enter a valid card number (try 4111 1111 1111 1111)';
    const expiry = String(form.get('expiry') ?? '');
    const m = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(expiry);
    if (!m || new Date(2000 + Number(m[2]), Number(m[1])) < new Date()) errors.expiry = 'Enter a future expiry as MM/YY';
    if (!/^\d{3,4}$/.test(String(form.get('cvv') ?? ''))) errors.cvv = 'Enter the 3 or 4 digit CVV';
  } else if (!form.get('bank')) {
    errors.bank = 'Choose your bank';
  }
  return errors;
}

export function PayPage() {
  const { attemptId } = useParams();
  const attempt = useQuery({
    queryKey: ['payments', 'attempt', attemptId, 'once'],
    queryFn: ({ signal }) => api.get<PaymentAttemptStatusDto>(`/payments/attempts/${attemptId}`, signal),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const ref = attempt.data?.attempt.gatewayRef;
  const charge = useQuery({
    queryKey: ['gateway', ref],
    queryFn: ({ signal }) => api.get<{ charge: GatewayChargeDto }>(`/payments/sim/${ref}`, signal),
    select: (d) => d.charge,
    enabled: Boolean(ref),
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (attempt.isPending || (ref && charge.isPending)) {
    return (
      <main className={`container ${styles.gatewayPage}`}>
        <LoadingRegion label="Loading payment">
          <Skeleton height={480} radius="md" />
        </LoadingRegion>
      </main>
    );
  }
  if (attempt.isError || charge.isError || !charge.data) {
    return (
      <main className="container">
        <ErrorState error={attempt.error ?? charge.error} title="We couldn’t open this payment" action={<ButtonLink to="/checkout">Back to checkout</ButtonLink>} />
      </main>
    );
  }
  // Already submitted or settled: the processing page knows what happened.
  if (charge.data.status !== 'created') return <Navigate to={`/checkout/processing/${attemptId}`} replace />;
  return <GatewayForm attemptId={attemptId!} charge={charge.data} />;
}

function GatewayForm({ attemptId, charge }: { attemptId: string; charge: GatewayChargeDto }) {
  const navigate = useNavigate();
  const [method, setMethod] = useState<PaymentMethod>(charge.method);
  const [scenario, setScenario] = useState<PaymentScenario>('success');
  const [resolution, setResolution] = useState<'success' | 'failure'>('success');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [closedTab, setClosedTab] = useState(false);
  const countdown = useCountdown(charge.expiresAt);

  const submit = useMutation({
    mutationFn: (s: PaymentScenario) =>
      api.post<GatewaySubmitResponse>(`/payments/sim/${charge.gatewayRef}/submit`, { scenario: s, pendingResolution: resolution }),
    onSuccess: ({ redirectUrl }) => (redirectUrl ? navigate(redirectUrl, { replace: true }) : setClosedTab(true)),
  });

  const pay = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const errs = validateMethod(method, new FormData(e.currentTarget));
    setErrors(errs);
    // Only the chosen outcome is sent — never the payment details typed above.
    if (Object.keys(errs).length === 0) submit.mutate(scenario);
  };

  if (closedTab) {
    return (
      <main className={`container ${styles.gatewayPage}`}>
        <EmptyState
          icon={CheckCircle2}
          title="Payment submitted"
          body="This simulates closing the tab before returning to AVERO. Your order is confirmed in the background and you’ll get an email."
          action={<ButtonLink to={`/checkout/processing/${attemptId}`}>Check order status</ButtonLink>}
        />
      </main>
    );
  }

  if (countdown.over) {
    return (
      <main className={`container ${styles.gatewayPage}`}>
        <EmptyState
          icon={Clock}
          title="This payment session expired"
          body="No money was taken. You can start a new payment while your items are still reserved."
          action={<ButtonLink to={`/checkout/processing/${attemptId}`}>Continue</ButtonLink>}
        />
      </main>
    );
  }

  return (
    <main className={`container ${styles.gatewayPage}`}>
      <form className={styles.gateway} onSubmit={pay} noValidate>
        <header className={styles.gatewayHead}>
          <div>
            <p className="eyebrow">AVERO Pay</p>
            <p className={styles.merchant}>Paying {charge.merchant}</p>
          </div>
          <Badge tone="warning">Test mode</Badge>
        </header>
        <div className={styles.amountRow}>
          <p className={styles.amount}>{formatINR(charge.amountPaise)}</p>
          <p className={cx('meta', styles.timer)} aria-live="off">
            <Clock size={14} aria-hidden /> Session ends in <span className="tabular">{countdown.text}</span>
          </p>
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Pay with</legend>
          <div className={styles.methods}>
            {METHOD_TABS.map((m) => (
              <RadioCard
                key={m.value}
                name="method"
                value={m.value}
                checked={method === m.value}
                onChange={() => {
                  setMethod(m.value);
                  setErrors({});
                }}
                title={
                  <span className={styles.methodTitle}>
                    <m.icon size={16} aria-hidden /> {m.title}
                  </span>
                }
              />
            ))}
          </div>
          {method === 'upi' ? (
            <div className={styles.methodFields}>
              <Field label="UPI ID" name="vpa" placeholder="name@okhdfc" autoComplete="off" error={errors.vpa} hint="You’ll approve the request in your UPI app" />
            </div>
          ) : method === 'card' ? (
            <div className={cx(styles.methodFields, styles.cardFields)}>
              <div className={styles.full}>
                <Field label="Card number" name="cardNumber" inputMode="numeric" autoComplete="off" placeholder="4111 1111 1111 1111" error={errors.cardNumber} />
              </div>
              <Field label="Expiry (MM/YY)" name="expiry" inputMode="numeric" autoComplete="off" placeholder="12/30" error={errors.expiry} />
              <Field label="CVV" name="cvv" type="password" inputMode="numeric" autoComplete="off" maxLength={4} error={errors.cvv} />
            </div>
          ) : (
            <div className={styles.methodFields}>
              <SelectField label="Bank" name="bank" defaultValue="" error={errors.bank}>
                <option value="" disabled>
                  Choose your bank
                </option>
                {BANKS.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </SelectField>
            </div>
          )}
          <p className="meta">Test payments only. Details you enter here are checked in your browser and never sent.</p>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Simulate the outcome</legend>
          <div className={styles.scenarios}>
            {SCENARIOS.map((s) => (
              <RadioCard
                key={s.value}
                name="scenario"
                value={s.value}
                checked={scenario === s.value}
                onChange={() => setScenario(s.value)}
                title={s.title}
                description={s.description}
              />
            ))}
          </div>
          {scenario === 'pending' ? (
            <div className={styles.methods} role="radiogroup" aria-label="Pending payment resolves to">
              <RadioCard name="resolution" value="success" checked={resolution === 'success'} onChange={() => setResolution('success')} title="Then approved" />
              <RadioCard name="resolution" value="failure" checked={resolution === 'failure'} onChange={() => setResolution('failure')} title="Then declined" />
            </div>
          ) : null}
        </fieldset>

        <FormError message={submit.error ? errorMessage(submit.error) : null} />
        <div className={styles.gatewayActions}>
          <Button type="submit" size="lg" fullWidth loading={submit.isPending && submit.variables !== 'cancelled'} disabled={submit.isPending}>
            Pay {formatINR(charge.amountPaise)}
          </Button>
          <Button variant="ghost" disabled={submit.isPending} loading={submit.isPending && submit.variables === 'cancelled'} onClick={() => submit.mutate('cancelled')}>
            Cancel payment
          </Button>
        </div>
      </form>
    </main>
  );
}

/* ---------------- processing page: /checkout/processing/:attemptId ---------------- */

export function ProcessingPage() {
  const { attemptId } = useParams();
  const status = useAttemptStatus(attemptId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const retry = useStartPayment();
  const d = status.data;
  const reservation = useCountdown(d?.order.reservationExpiresAt);

  const confirmed = d && d.attempt.status === 'SUCCEEDED' && ['PAID', 'CONFIRMED'].includes(d.order.status);
  useEffect(() => {
    if (!confirmed) return;
    void qc.invalidateQueries({ queryKey: cartKey });
    navigate(`/order/confirmed/${d.order.orderNumber}`, { replace: true });
  }, [confirmed, d, navigate, qc]);

  if (status.isError) {
    return (
      <main className="container">
        <ErrorState error={status.error} title="We couldn’t find this payment" action={<ButtonLink to="/account/orders">Your orders</ButtonLink>} />
      </main>
    );
  }

  if (!d || confirmed || d.attempt.status === 'CREATED' || (d.attempt.status === 'SUCCEEDED' && d.order.status === 'PENDING_PAYMENT')) {
    return <Confirming status={d} attemptId={attemptId!} />;
  }

  const { attempt, order } = d;
  const tryAgain = () =>
    retry.mutate({ orderNumber: order.orderNumber, method: attempt.method }, { onSuccess: ({ attempt: next }) => navigate(`/checkout/pay/${next.id}`) });

  if (attempt.status === 'PENDING') {
    return (
      <main className={`container ${styles.statusPage}`}>
        <div className={styles.statusCard} role="status" aria-live="polite">
          <Hourglass size={36} strokeWidth={1.4} className={styles.iconWarning} aria-hidden />
          <h1 className={styles.statusTitle}>Your bank is still processing</h1>
          <p>
            We’re waiting for {formatINR(attempt.amountPaise)} to be confirmed. Your items stay reserved
            {reservation.text ? <> (<span className="tabular">{reservation.text}</span> left)</> : null}.
          </p>
          <p className="meta">You can close this page — we’ll email you as soon as order {order.orderNumber} is confirmed.</p>
        </div>
      </main>
    );
  }

  if (attempt.status === 'SUCCEEDED' && order.status === 'CANCELLED') {
    return (
      <main className={`container ${styles.statusPage}`}>
        <div className={styles.statusCard} role="alert">
          <PackageX size={36} strokeWidth={1.4} className={styles.iconDanger} aria-hidden />
          <h1 className={styles.statusTitle}>We’re sorry — this order couldn’t be completed</h1>
          <p>
            Your payment reached us after your reservation ended, and the items sold out in the meantime. We’ve started a full refund of{' '}
            {formatINR(attempt.amountPaise)}.
          </p>
          <div className={styles.statusActions}>
            <ButtonLink to={`/order/confirmed/${order.orderNumber}`} variant="secondary">
              View order
            </ButtonLink>
            <ButtonLink to="/bag">Back to bag</ButtonLink>
          </div>
        </div>
      </main>
    );
  }

  // FAILED / CANCELLED / EXPIRED attempt.
  return (
    <main className={`container ${styles.statusPage}`}>
      <div className={styles.statusCard} role="alert">
        <XCircle size={36} strokeWidth={1.4} className={styles.iconDanger} aria-hidden />
        <h1 className={styles.statusTitle}>
          {order.status === 'EXPIRED' || attempt.failureReason === 'order_expired'
            ? 'Your reservation ended'
            : attempt.status === 'CANCELLED'
              ? 'Payment cancelled'
              : 'Payment unsuccessful'}
        </h1>
        <p>{failureText(attempt.failureReason)} No money was taken.</p>
        {order.canPay ? (
          <>
            <p className="meta">
              Your items are reserved for <span className="tabular">{reservation.text}</span> more.
            </p>
            <div className={styles.statusActions}>
              <Button loading={retry.isPending} onClick={tryAgain}>
                Try again
              </Button>
              <ButtonLink to="/bag" variant="secondary">
                Back to bag
              </ButtonLink>
            </div>
          </>
        ) : (
          <>
            <p className="meta">The reservation for order {order.orderNumber} has ended. Your bag is still saved, so you can check out again.</p>
            <div className={styles.statusActions}>
              <ButtonLink to="/checkout">Check out again</ButtonLink>
              <ButtonLink to="/bag" variant="secondary">
                Back to bag
              </ButtonLink>
            </div>
          </>
        )}
        <FormError message={retry.error ? errorMessage(retry.error) : null} />
      </div>
    </main>
  );
}

/** Waiting for the gateway's verdict. Distinguishes "never submitted" and "bank is slow". */
function Confirming({ status, attemptId }: { status: PaymentAttemptStatusDto | undefined; attemptId: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 20_000);
    return () => window.clearTimeout(t);
  }, []);
  const ref = status?.attempt.status === 'CREATED' ? status.attempt.gatewayRef : undefined;
  const charge = useQuery({
    queryKey: ['gateway', ref],
    queryFn: ({ signal }) => api.get<{ charge: GatewayChargeDto }>(`/payments/sim/${ref}`, signal),
    select: (d) => d.charge,
    enabled: Boolean(ref),
    refetchInterval: 5000,
  });
  const expires = useCountdown(status?.attempt.expiresAt);

  if (charge.data?.status === 'created') {
    return (
      <main className={`container ${styles.statusPage}`}>
        <div className={styles.statusCard}>
          <Clock size={36} strokeWidth={1.4} className={styles.iconWarning} aria-hidden />
          <h1 className={styles.statusTitle}>Payment not completed yet</h1>
          <p>You left the payment page before paying. Nothing has been charged.</p>
          <div className={styles.statusActions}>
            <ButtonLink to={`/checkout/pay/${attemptId}`}>Return to payment</ButtonLink>
          </div>
        </div>
      </main>
    );
  }
  return (
    <main className={`container ${styles.statusPage}`}>
      <div className={styles.statusCard} role="status" aria-live="polite">
        <LoaderCircle size={36} className={styles.spin} aria-hidden />
        <h1 className={styles.statusTitle}>{slow ? 'Still waiting for your bank' : 'Confirming your payment…'}</h1>
        {slow ? (
          <p className="meta">
            Some banks take a few minutes. This page updates by itself{expires.text ? ` (up to ${expires.text})` : ''}, and we’ll email you either way.
            Please don’t pay again.
          </p>
        ) : (
          <p className="meta">This usually takes a few seconds. Please don’t pay again — it’s safe to refresh this page.</p>
        )}
      </div>
    </main>
  );
}
