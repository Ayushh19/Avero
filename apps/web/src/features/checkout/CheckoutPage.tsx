import {
  formatINR,
  type CheckoutAddressInput,
  type CheckoutSessionDto,
  type PaymentMethod,
  type QuoteDto,
} from '@avero/shared';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Clock, Info, Lock, ShoppingBag, Tag } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '../../components/ui/Feedback';
import { Checkbox, Field, FormError, RadioCard } from '../../components/ui/Form';
import { ProductMedia } from '../../components/ui/Merch';
import { Stepper } from '../../components/ui/Nav';
import { ApiError, errorMessage, fieldErrors } from '../../lib/api';
import { cx } from '../../lib/cx';
import { AddressForm } from '../account/AddressForm';
import { useAddresses } from '../account/sections';
import { useMe, usePublicConfig } from '../auth/hooks';
import { cartKey } from '../bag/hooks';
import {
  useCheckoutSession,
  usePatchSession,
  usePlaceOrder,
  useQuote,
  useSessionKey,
  useStartPayment,
} from './hooks';
import styles from './Checkout.module.css';

const STEPS = ['Contact', 'Address', 'Delivery', 'Review & pay'];

/** Where to land when the page (re)loads: the first incomplete step, or review if a quote is held. */
function initialStep(s: CheckoutSessionDto): number {
  if (!s.email || !s.phone) return 0;
  if (!s.address) return 1;
  return s.quote ? 3 : 2;
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const day = (ymd: string) =>
  new Date(`${ymd}T12:00:00+05:30`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  });
const dateRange = (a: string, b: string) => (a === b ? day(a) : `${day(a)} – ${day(b)}`);
const addressLine = (a: CheckoutAddressInput) =>
  [a.line1, a.line2, a.landmark, `${a.city}, ${a.state} ${a.pincode}`].filter(Boolean).join(', ');

export function CheckoutPage() {
  const session = useCheckoutSession();
  const [step, setStep] = useState<number | null>(null);

  if (session.isPending) {
    return (
      <main className={`container ${styles.page}`}>
        <LoadingRegion label="Loading checkout">
          <div className={styles.layout}>
            <div className={styles.steps}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={i === 0 ? 220 : 72} radius="md" />
              ))}
            </div>
            <Skeleton height={360} radius="md" />
          </div>
        </LoadingRegion>
      </main>
    );
  }

  if (session.isError) {
    const err = session.error;
    if (err instanceof ApiError && err.code === 'CART_NOT_READY') {
      return (
        <main className="container">
          <EmptyState
            icon={ShoppingBag}
            title={
              err.message === 'Your bag is empty' ? 'Your bag is empty' : 'Your bag needs attention'
            }
            body={
              err.message === 'Your bag is empty'
                ? 'Add something you love, then come back to check out.'
                : err.message
            }
            action={
              <ButtonLink to={err.message === 'Your bag is empty' ? '/' : '/bag'}>
                {err.message === 'Your bag is empty' ? 'Start shopping' : 'Review your bag'}
              </ButtonLink>
            }
          />
        </main>
      );
    }
    // "Buy now" on an item that sold out or was withdrawn since the product page loaded.
    if (err instanceof ApiError && (err.code === 'SKU_OUT_OF_STOCK' || err.code === 'SKU_UNAVAILABLE')) {
      return (
        <main className="container">
          <EmptyState
            icon={ShoppingBag}
            title={err.message}
            body="Pick another size or colour, or keep browsing."
            action={<ButtonLink to="/collections/new-arrivals">Keep shopping</ButtonLink>}
          />
        </main>
      );
    }
    return (
      <main className="container">
        <ErrorState
          error={err}
          title="We couldn’t start checkout"
          action={<Button onClick={() => session.refetch()}>Try again</Button>}
        />
      </main>
    );
  }

  const s = session.data;
  const current = step ?? initialStep(s);
  return (
    <main className={`container ${styles.page}`}>
      <h1 className="visually-hidden">Checkout</h1>
      <div className={styles.stepper}>
        <Stepper steps={STEPS} current={current} />
      </div>
      {s.pendingOrder ? <PendingOrderBanner pending={s.pendingOrder} /> : null}
      <div className={styles.layout}>
        <div className={styles.steps}>
          <ContactStep session={s} index={0} current={current} go={setStep} />
          <AddressStep session={s} index={1} current={current} go={setStep} />
          <DeliveryStep session={s} index={2} current={current} go={setStep} />
          <ReviewStep session={s} index={3} current={current} />
        </div>
        <aside aria-label="Order summary">
          <OrderSummary session={s} />
        </aside>
      </div>
    </main>
  );
}

/* ---------------- step shell ---------------- */

interface StepProps {
  session: CheckoutSessionDto;
  index: number;
  current: number;
  go: (step: number) => void;
}

function StepShell({
  index,
  current,
  title,
  summary,
  onEdit,
  children,
}: {
  index: number;
  current: number;
  title: string;
  summary?: ReactNode;
  onEdit?: () => void;
  children: ReactNode;
}) {
  const state = index < current ? 'done' : index === current ? 'current' : 'upcoming';
  return (
    <section
      className={cx(styles.step, state === 'upcoming' && styles.stepUpcoming)}
      aria-labelledby={`step-${index}`}
    >
      <div className={styles.stepHead}>
        <h2 id={`step-${index}`} className={styles.stepTitle}>
          <span className={styles.stepNumber}>{index + 1}</span> {title}
        </h2>
        {state === 'done' && onEdit ? (
          <button
            type="button"
            className={styles.edit}
            onClick={onEdit}
            aria-label={`Edit ${title.toLowerCase()}`}
          >
            Edit
          </button>
        ) : null}
      </div>
      {state === 'done' && summary ? <div className={styles.stepSummary}>{summary}</div> : null}
      {state === 'current' ? children : null}
    </section>
  );
}

/* ---------------- 1. contact ---------------- */

function ContactStep({ session, index, current, go }: StepProps) {
  const patch = usePatchSession(session.id);
  const { data: user } = useMe();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: { email?: string; phone: string } = { phone: String(form.get('phone') ?? '') };
    if (session.isGuest) body.email = String(form.get('email') ?? '');
    patch.mutate(body, { onSuccess: () => go(index + 1) });
  };
  const errs = fieldErrors(patch.error);
  return (
    <StepShell
      index={index}
      current={current}
      title="Contact"
      onEdit={() => go(index)}
      summary={
        <>
          {session.email}
          <br />
          {session.phone}
        </>
      }
    >
      <form onSubmit={submit} noValidate className={styles.fields}>
        {session.isGuest ? (
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={session.email ?? ''}
            error={errs.email}
            hint="We’ll send your order confirmation here"
          />
        ) : (
          <div>
            <p className="eyebrow">Signed in as</p>
            <p>{user?.email ?? session.email}</p>
          </div>
        )}
        <Field
          label="Mobile number"
          name="phone"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          defaultValue={session.phone?.replace(/^\+91/, '') ?? ''}
          error={errs.phone}
          hint="For delivery updates"
        />
        <div className={styles.actions}>
          <Button type="submit" loading={patch.isPending}>
            Continue
          </Button>
          {session.isGuest ? (
            <p className="meta">
              Have an account? <Link to="/signin?returnTo=/checkout">Sign in</Link> for saved
              addresses and rewards.
            </p>
          ) : null}
        </div>
        {!errs.email && !errs.phone ? (
          <FormError message={patch.error ? errorMessage(patch.error) : null} />
        ) : null}
      </form>
    </StepShell>
  );
}

/* ---------------- 2. address ---------------- */

function AddressStep({ session, index, current, go }: StepProps) {
  const patch = usePatchSession(session.id);
  const member = !session.isGuest;
  const addresses = useAddresses({ enabled: member });
  const saved = member ? (addresses.data ?? []) : [];
  const matching = saved.find(
    (a) =>
      session.address && a.line1 === session.address.line1 && a.pincode === session.address.pincode,
  );
  const [choice, setChoice] = useState<string | 'new' | null>(null);
  const selected =
    choice ??
    matching?.id ??
    saved.find((a) => a.isDefault && a.serviceable)?.id ??
    (saved.length ? null : 'new');
  const [saveToBook, setSaveToBook] = useState(true);

  const done = () => go(index + 1);
  const useNew = (input: CheckoutAddressInput & { isDefault?: boolean }) => {
    const { isDefault: _ignored, ...address } = input;
    patch.mutate({ address, saveAddress: member && saveToBook }, { onSuccess: done });
  };

  return (
    <StepShell
      index={index}
      current={current}
      title="Delivery address"
      onEdit={() => go(index)}
      summary={
        session.address ? (
          <>
            <strong>{session.address.fullName}</strong> · {session.address.phone}
            <br />
            {addressLine(session.address)}
          </>
        ) : null
      }
    >
      {member && addresses.isPending ? <Skeleton height={96} radius="md" /> : null}
      {saved.length ? (
        <div className={styles.options} role="radiogroup" aria-label="Saved addresses">
          {saved.map((a) => (
            <RadioCard
              key={a.id}
              name="address"
              value={a.id}
              checked={selected === a.id}
              disabled={!a.serviceable}
              onChange={() => setChoice(a.id)}
              title={
                <>
                  {a.fullName}
                  {a.isDefault ? <span className="meta"> · Default</span> : null}
                </>
              }
              description={
                a.serviceable ? addressLine(a) : `${addressLine(a)} — we don’t deliver here yet`
              }
            />
          ))}
          <RadioCard
            name="address"
            value="new"
            checked={selected === 'new'}
            onChange={() => setChoice('new')}
            title="Use a new address"
          />
        </div>
      ) : null}

      {selected === 'new' ? (
        <>
          {member ? (
            <Checkbox
              label="Save this address to my account"
              checked={saveToBook}
              onChange={(e) => setSaveToBook(e.target.checked)}
            />
          ) : null}
          <AddressForm
            initial={session.address && !matching ? session.address : undefined}
            onSubmit={useNew}
            submitting={patch.isPending}
            serverError={patch.error ? errorMessage(patch.error) : null}
            submitLabel="Deliver here"
            showDefault={false}
          />
        </>
      ) : selected ? (
        <div className={styles.actions}>
          <Button
            loading={patch.isPending}
            onClick={() => patch.mutate({ addressId: selected }, { onSuccess: done })}
          >
            Deliver here
          </Button>
          <FormError message={patch.error ? errorMessage(patch.error) : null} />
        </div>
      ) : null}
    </StepShell>
  );
}

/* ---------------- 3. delivery ---------------- */

function DeliveryStep({ session, index, current, go }: StepProps) {
  const patch = usePatchSession(session.id);
  const { data: config } = usePublicConfig();
  const subtotal = session.quote?.subtotalPaise ?? session.subtotalPaise;
  const threshold = config?.freeShippingThresholdPaise ?? 0;
  // Show the shopper's choice immediately; the server's answer replaces it (or reverts on error).
  const [picked, setPicked] = useState<CheckoutSessionDto['shippingMethod'] | null>(null);
  const chosen = picked ?? session.shippingMethod;
  const choose = (shippingMethod: CheckoutSessionDto['shippingMethod']) => {
    setPicked(shippingMethod);
    patch.mutate({ shippingMethod }, { onSettled: () => setPicked(null) });
  };
  const option = session.shippingOptions.find((o) => o.method === session.shippingMethod);
  const feeText = (method: string, fee: number) =>
    method === 'standard' && subtotal >= threshold ? 'Free' : formatINR(fee);

  return (
    <StepShell
      index={index}
      current={current}
      title="Delivery"
      onEdit={() => go(index)}
      summary={
        option ? `${option.label} · arrives ${dateRange(option.earliest, option.latest)}` : null
      }
    >
      <div className={styles.options} role="radiogroup" aria-label="Delivery method">
        {session.shippingOptions.map((o) => (
          <RadioCard
            key={o.method}
            name="shipping"
            value={o.method}
            checked={chosen === o.method}
            onChange={() => choose(o.method)}
            title={o.label}
            description={`Arrives ${dateRange(o.earliest, o.latest)}`}
            aside={<span className="tabular">{feeText(o.method, o.feePaise)}</span>}
          />
        ))}
      </div>
      {session.shippingOptions.length === 1 ? (
        <p className={styles.note}>
          <Info size={15} aria-hidden /> Express delivery is available in metro cities only.
        </p>
      ) : null}
      <FormError message={patch.error ? errorMessage(patch.error) : null} />
      <div className={styles.actions}>
        <Button onClick={() => go(index + 1)} disabled={patch.isPending}>
          Continue to review
        </Button>
      </div>
    </StepShell>
  );
}

/* ---------------- 4. review & pay ---------------- */

const METHODS: { value: PaymentMethod; title: string; description: string }[] = [
  { value: 'upi', title: 'UPI', description: 'Pay with any UPI app' },
  { value: 'card', title: 'Credit or debit card', description: 'Visa, Mastercard, RuPay' },
  { value: 'netbanking', title: 'Net banking', description: 'All major Indian banks' },
];

type ChangeRow = {
  type: string;
  productName?: string;
  fromPaise?: number;
  toPaise?: number;
  from?: number;
  to?: number;
};

function describeChange(c: ChangeRow): string | null {
  switch (c.type) {
    case 'price':
      return `${c.productName}: ${formatINR(c.fromPaise!)} → ${formatINR(c.toPaise!)}`;
    case 'qty':
      return `${c.productName}: quantity ${c.from} → ${c.to}`;
    case 'line_removed':
      return `${c.productName} is no longer in your order`;
    case 'line_added':
      return `${c.productName} was added`;
    case 'coupon':
      return `Coupon discount ${formatINR(c.fromPaise!)} → ${formatINR(c.toPaise!)}`;
    case 'shipping':
      return `Shipping ${formatINR(c.fromPaise!)} → ${formatINR(c.toPaise!)}`;
    case 'points':
      return `Points used ${c.from} → ${c.to}`;
    default:
      return null;
  }
}

function ReviewStep({ session, index, current }: Omit<StepProps, 'go'>) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const place = usePlaceOrder();
  const startPayment = useStartPayment();
  const quote = useQuote(session.id);
  const [method, setMethod] = useState<PaymentMethod>('upi');
  const [problem, setProblem] = useState<{
    tone: 'warning' | 'danger';
    title: string;
    items?: string[];
    bagLink?: boolean;
  } | null>(null);
  const placedOrder = useRef<string | null>(null);
  const q = session.quote;

  const goPay = async (orderNumber: string) => {
    const { attempt } = await startPayment.mutateAsync({ orderNumber, method });
    navigate(`/checkout/pay/${attempt.id}`);
  };

  const pay = async () => {
    setProblem(null);
    try {
      if (placedOrder.current) return await goPay(placedOrder.current);
      const hash = q?.hash ?? (await quote.mutateAsync()).quote.hash;
      const { order } = await place.mutateAsync({ sessionId: session.id, quoteHash: hash });
      placedOrder.current = order.orderNumber;
      // The bag will be trimmed server-side once payment succeeds; refresh what we show.
      void qc.invalidateQueries({ queryKey: cartKey });
      await goPay(order.orderNumber);
    } catch (err) {
      if (!(err instanceof ApiError))
        return setProblem({ tone: 'danger', title: errorMessage(err) });
      const details = err.details as { changes?: ChangeRow[]; orderNumber?: string } | undefined;
      switch (err.code) {
        case 'QUOTE_CHANGED':
          return setProblem({
            tone: 'warning',
            title: 'Your order summary changed. Please check the new total before paying.',
            items: (details?.changes ?? [])
              .map(describeChange)
              .filter((x): x is string => Boolean(x)),
          });
        case 'QUOTE_EXPIRED':
          return setProblem({
            tone: 'warning',
            title:
              'We refreshed your prices because the summary was more than 10 minutes old. Please confirm to pay.',
          });
        case 'SKU_OUT_OF_STOCK':
        case 'SKU_UNAVAILABLE':
        case 'CART_NOT_READY':
          void qc.invalidateQueries({ queryKey: cartKey });
          return setProblem({
            tone: 'danger',
            title: `${err.message}. Nothing has been charged.`,
            bagLink: session.mode === 'bag',
          });
        case 'CONFLICT':
          if (details?.orderNumber) {
            placedOrder.current = details.orderNumber;
            return goPay(details.orderNumber).catch((e: unknown) =>
              setProblem({ tone: 'danger', title: errorMessage(e) }),
            );
          }
          return setProblem({ tone: 'danger', title: err.message });
        default:
          return setProblem({
            tone: err.code.startsWith('COUPON_') ? 'warning' : 'danger',
            title: err.message,
          });
      }
    }
  };

  const busy = place.isPending || startPayment.isPending || quote.isPending;
  return (
    <StepShell index={index} current={current} title="Review & pay">
      <div className={styles.options} role="radiogroup" aria-label="Payment method">
        {METHODS.map((m) => (
          <RadioCard
            key={m.value}
            name="method"
            value={m.value}
            checked={method === m.value}
            onChange={() => setMethod(m.value)}
            title={m.title}
            description={m.description}
          />
        ))}
      </div>
      {problem ? (
        <div
          className={cx(
            styles.banner,
            problem.tone === 'warning' ? styles.bannerWarning : styles.bannerDanger,
          )}
          role="alert"
        >
          <div className={styles.bannerText}>
            <AlertCircle size={16} aria-hidden />
            <div>
              <p>{problem.title}</p>
              {problem.items?.length ? (
                <ul className={styles.changes}>
                  {problem.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
          {problem.bagLink ? (
            <ButtonLink to="/bag" variant="secondary" size="sm">
              Review bag
            </ButtonLink>
          ) : null}
        </div>
      ) : null}
      <Button
        size="lg"
        fullWidth
        loading={busy}
        disabled={!q && !session.ready}
        icon={<Lock size={16} aria-hidden />}
        onClick={() => void pay()}
      >
        {q ? `Pay ${formatINR(q.totalPaise)}` : 'Pay'}
      </Button>
      <p className="meta">
        You’ll complete payment on our secure (simulated) payment page. Your items are reserved for
        15 minutes once you continue.
      </p>
    </StepShell>
  );
}

/* ---------------- pending order ---------------- */

function PendingOrderBanner({
  pending,
}: {
  pending: NonNullable<CheckoutSessionDto['pendingOrder']>;
}) {
  const navigate = useNavigate();
  const start = useStartPayment();
  return (
    <div className={cx(styles.banner, styles.bannerWarning)} role="status">
      <p className={styles.bannerText}>
        <Clock size={16} aria-hidden />
        <span>
          Order <strong>{pending.orderNumber}</strong> ({formatINR(pending.totalPaise)}) is waiting
          for payment. Your items are reserved until {time(pending.reservationExpiresAt)}.
        </span>
      </p>
      <Button
        size="sm"
        variant="secondary"
        loading={start.isPending}
        onClick={() =>
          start.mutate(
            { orderNumber: pending.orderNumber, method: 'upi' },
            { onSuccess: ({ attempt }) => navigate(`/checkout/pay/${attempt.id}`) },
          )
        }
      >
        Complete payment
      </Button>
      {start.error ? <p role="alert">{errorMessage(start.error)}</p> : null}
    </div>
  );
}

/* ---------------- summary ---------------- */

function quoteKey(s: CheckoutSessionDto) {
  return JSON.stringify([
    s.email,
    s.phone,
    s.address,
    s.shippingMethod,
    s.couponCode,
    s.pointsToRedeem,
  ]);
}

function OrderSummary({ session }: { session: CheckoutSessionDto }) {
  const quote = useQuote(session.id);
  const q = session.quote;
  const failedFor = useRef<string | null>(null);
  const qc = useQueryClient();
  const sessionKey = useSessionKey();

  // Keep a live quote whenever the details are complete (any change clears it server-side).
  const key = quoteKey(session);
  const quoteMutate = quote.mutate;
  useEffect(() => {
    if (!session.ready || q || quote.isPending || failedFor.current === key) return;
    quoteMutate(undefined, { onError: () => (failedFor.current = key) });
  }, [session.ready, q, quote.isPending, key, quoteMutate]);

  // Re-quote when the held prices expire.
  useEffect(() => {
    if (!q) return;
    const ms = new Date(q.expiresAt).getTime() - Date.now();
    const t = window.setTimeout(
      () => {
        qc.setQueryData<{ session: CheckoutSessionDto }>(sessionKey, (prev) =>
          prev ? { session: { ...prev.session, quote: null } } : prev,
        );
      },
      Math.max(ms, 0) + 500,
    );
    return () => window.clearTimeout(t);
  }, [q, qc, sessionKey]);

  const lines = q
    ? q.lines.map((l) => ({
        key: l.skuId,
        name: l.productName,
        meta: `${l.colorName} · Size ${l.sizeLabel}`,
        qty: l.qty,
        image: l.image,
        total: l.subtotalPaise,
      }))
    : session.items.map((l) => ({
        key: l.skuId,
        name: l.productName,
        meta: `${l.colorName} · Size ${l.sizeLabel}`,
        qty: l.qty,
        image: l.image,
        total: l.totalPaise,
      }));

  return (
    <div className={styles.summary}>
      <h2 className={styles.summaryTitle}>Order summary</h2>
      <ul role="list" className={styles.lines}>
        {lines.map((l) => (
          <li key={l.key} className={styles.line}>
            <span className={styles.lineMedia}>
              <ProductMedia image={l.image} alt="" radius="md" sizes="64px" />
              <span className={styles.qty} aria-label={`Quantity ${l.qty}`}>
                {l.qty}
              </span>
            </span>
            <span>
              <span className={styles.lineName}>{l.name}</span>
              <br />
              <span className="meta">{l.meta}</span>
            </span>
            <span className="tabular">{formatINR(l.total)}</span>
          </li>
        ))}
      </ul>

      <CouponField session={session} quote={q} />
      {q && q.points.balance > 0 ? <PointsField session={session} quote={q} /> : null}

      {q ? (
        <QuoteTotals quote={q} />
      ) : (
        <EstimateTotals subtotal={session.subtotalPaise} />
      )}
      {quote.error && !q ? <FormError message={errorMessage(quote.error)} /> : null}
      {q ? (
        <p className={styles.held}>
          Inclusive of GST ({formatINR(q.taxIncludedPaise)}). Prices held until {time(q.expiresAt)}.
        </p>
      ) : null}
    </div>
  );
}

function QuoteTotals({ quote: q }: { quote: QuoteDto }) {
  return (
    <dl className={styles.rows}>
      <div>
        <dt>
          Subtotal ({q.itemCount} {q.itemCount === 1 ? 'item' : 'items'})
        </dt>
        <dd className="tabular">{formatINR(q.subtotalPaise)}</dd>
      </div>
      {q.couponDiscountPaise > 0 ? (
        <div className={styles.discount}>
          <dt>Coupon {q.coupon?.code}</dt>
          <dd className="tabular">−{formatINR(q.couponDiscountPaise)}</dd>
        </div>
      ) : null}
      {q.pointsDiscountPaise > 0 ? (
        <div className={styles.discount}>
          <dt>{q.points.redeemed} points</dt>
          <dd className="tabular">−{formatINR(q.pointsDiscountPaise)}</dd>
        </div>
      ) : null}
      <div>
        <dt>{q.shipping.method === 'express' ? 'Express delivery' : 'Delivery'}</dt>
        <dd className="tabular">
          {q.shippingPaise === 0 ? (
            q.shipping.waivedPaise > 0 ? (
              <span className={styles.discount}>Free with {q.coupon?.code}</span>
            ) : (
              'Free'
            )
          ) : (
            formatINR(q.shippingPaise)
          )}
        </dd>
      </div>
      <div className={styles.total}>
        <dt>Total</dt>
        <dd className="tabular">{formatINR(q.totalPaise)}</dd>
      </div>
      {q.pointsToEarn > 0 ? (
        <p className="meta">You’ll earn {q.pointsToEarn} points with this order.</p>
      ) : null}
    </dl>
  );
}

function EstimateTotals({ subtotal }: { subtotal: number }) {
  return (
    <dl className={styles.rows}>
      <div>
        <dt>Subtotal</dt>
        <dd className="tabular">{formatINR(subtotal)}</dd>
      </div>
      <div>
        <dt>Delivery</dt>
        <dd className="meta">Calculated after address</dd>
      </div>
    </dl>
  );
}

function CouponField({ session, quote }: { session: CheckoutSessionDto; quote: QuoteDto | null }) {
  const patch = usePatchSession(session.id);
  const [code, setCode] = useState('');
  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim()) patch.mutate({ couponCode: code.trim() }, { onSuccess: () => setCode('') });
  };

  if (session.couponCode) {
    const invalid = quote?.couponError;
    return (
      <div
        className={cx(styles.applied, invalid && styles.appliedInvalid)}
        role={invalid ? 'alert' : undefined}
      >
        <span>
          <Tag size={14} aria-hidden />{' '}
          <span className={styles.appliedCode}>{session.couponCode}</span>
          {invalid
            ? ` — ${invalid.message}`
            : quote?.coupon?.description
              ? ` · ${quote.coupon.description}`
              : ' applied'}
        </span>
        <button
          type="button"
          className={styles.textButton}
          onClick={() => patch.mutate({ couponCode: null })}
          disabled={patch.isPending}
        >
          Remove
        </button>
      </div>
    );
  }
  return (
    <div className={styles.couponBox}>
      {session.personalCoupons.map((c) => (
        <div key={c.code} className={styles.offer}>
          <span>
            <Tag size={14} aria-hidden /> <span className={styles.appliedCode}>{c.code}</span>
            <br />
            <span className="meta">{c.description}</span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            loading={patch.isPending && patch.variables?.couponCode === c.code}
            onClick={() => patch.mutate({ couponCode: c.code })}
          >
            Apply
          </Button>
        </div>
      ))}
      <form onSubmit={apply} className={styles.inline} noValidate>
        <Field
          label="Coupon code"
          name="coupon"
          autoComplete="off"
          autoCapitalize="characters"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={patch.error ? errorMessage(patch.error) : undefined}
        />
        <Button
          type="submit"
          variant="secondary"
          className={styles.inlineButton}
          loading={patch.isPending && patch.variables?.couponCode === code.trim()}
          disabled={!code.trim()}
        >
          Apply
        </Button>
      </form>
    </div>
  );
}

function PointsField({ session, quote }: { session: CheckoutSessionDto; quote: QuoteDto }) {
  const patch = usePatchSession(session.id);
  const max = quote.points.maxRedeemable;
  const [pending, setPending] = useState<number | null>(null);
  const using = (pending ?? session.pointsToRedeem) > 0;
  const toggle = (on: boolean) => {
    const pointsToRedeem = on ? max : 0;
    setPending(pointsToRedeem);
    patch.mutate({ pointsToRedeem }, { onSettled: () => setPending(null) });
  };
  return (
    <div>
      <Checkbox
        label={
          using && session.pointsToRedeem > 0
            ? `Using ${quote.points.redeemed} points (−${formatINR(quote.pointsDiscountPaise)})`
            : `Use ${max} of your ${quote.points.balance} points (−${formatINR(max * 100)})`
        }
        checked={using}
        disabled={!using && max === 0}
        onChange={(e) => toggle(e.target.checked)}
      />
      <p className="meta">Up to 20% of your order can be paid with points.</p>
      <FormError message={patch.error ? errorMessage(patch.error) : null} />
    </div>
  );
}
