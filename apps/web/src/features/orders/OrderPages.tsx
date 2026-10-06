import { formatINR, orderLookupSchema, type OrderDto } from '@avero/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Gift, Package, PackageSearch, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Commerce';
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '../../components/ui/Feedback';
import { Field, FormError } from '../../components/ui/Form';
import { ProductMedia } from '../../components/ui/Merch';
import { OrderTimeline } from '../../components/ui/Nav';
import { ApiError, errorMessage } from '../../lib/api';
import { cx } from '../../lib/cx';
import { useMe } from '../auth/hooks';
import { cartKey } from '../bag/hooks';
import { useStartPayment } from '../checkout/hooks';
import { STATUS_COPY, failureText, longDate, timelineFor, useClaimOrders, useOrder, useOrderLookup, useOrders } from './hooks';
import { ExchangeNote, OrderActions, RefundsPanel, ReturnsPanel, ShipmentPanel } from './PostPurchase';
import styles from './Orders.module.css';
import { singleImage } from '../../lib/images';

const placedDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

function PageSkeleton() {
  return (
    <LoadingRegion label="Loading order">
      <div className={styles.stack}>
        <Skeleton width="45%" height={36} />
        <Skeleton height={140} radius="md" />
        <Skeleton height={260} radius="md" />
      </div>
    </LoadingRegion>
  );
}

/* ---------------- building blocks ---------------- */

const ITEM_STATUS: Partial<Record<OrderDto['items'][number]['status'], { label: string; tone: 'neutral' | 'warning' | 'success' }>> = {
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  RETURN_REQUESTED: { label: 'Return in progress', tone: 'warning' },
  EXCHANGE_REQUESTED: { label: 'Exchange in progress', tone: 'warning' },
  RETURNED: { label: 'Returned', tone: 'neutral' },
  REFUNDED: { label: 'Refunded', tone: 'neutral' },
  EXCHANGED: { label: 'Exchanged', tone: 'neutral' },
};

function OrderItems({ order }: { order: OrderDto }) {
  return (
    <ul role="list" className={styles.items}>
      {order.items.map((i) => (
        <li key={i.id} className={styles.item}>
          <Link to={i.href} className={styles.itemMedia} tabIndex={-1} aria-hidden>
            <ProductMedia image={singleImage(i.imageUrl)} alt="" radius="md" sizes="88px" />
          </Link>
          <div>
            <Link to={i.href} className={styles.itemName}>
              {i.productName}
            </Link>
            <p className="meta">
              {i.colorName} · Size {i.sizeLabel} · Qty {i.qty}
            </p>
            {ITEM_STATUS[i.status] ? <Badge tone={ITEM_STATUS[i.status]!.tone}>{ITEM_STATUS[i.status]!.label}</Badge> : null}
            {i.status === 'DELIVERED' && !order.isGuest && order.kind === 'sale' ? (
              <Link to={`/account/reviews/new/${i.id}`} className={styles.reviewLink}>
                Write a review
              </Link>
            ) : null}
          </div>
          <div className={styles.itemPrice}>
            <span className="tabular">{formatINR(i.totalPaise)}</span>
            {i.discountPaise + i.pointsDiscountPaise > 0 ? (
              <s className="meta tabular">{formatINR(i.unitPricePaise * i.qty)}</s>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function OrderTotals({ order }: { order: OrderDto }) {
  return (
    <>
      <dl className={styles.rows}>
        <div>
          <dt>Subtotal</dt>
          <dd className="tabular">{formatINR(order.subtotalPaise)}</dd>
        </div>
        {order.discountPaise > 0 ? (
          <div className={styles.discount}>
            <dt>Coupon {order.couponCode}</dt>
            <dd className="tabular">−{formatINR(order.discountPaise)}</dd>
          </div>
        ) : null}
        {order.pointsDiscountPaise > 0 ? (
          <div className={styles.discount}>
            <dt>{order.pointsRedeemed} points</dt>
            <dd className="tabular">−{formatINR(order.pointsDiscountPaise)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{order.shippingMethod === 'express' ? 'Express delivery' : 'Delivery'}</dt>
          <dd className="tabular">{order.shippingPaise === 0 ? 'Free' : formatINR(order.shippingPaise)}</dd>
        </div>
        <div className={styles.total}>
          <dt>{order.paidPaise > 0 ? 'Paid' : 'Total'}</dt>
          <dd className="tabular">{formatINR(order.paidPaise > 0 ? order.paidPaise : order.totalPaise)}</dd>
        </div>
      </dl>
      <p className="meta">Includes GST of {formatINR(order.taxIncludedPaise)}.</p>
    </>
  );
}

function AddressBlock({ order }: { order: OrderDto }) {
  const a = order.address;
  return (
    <address className={styles.address}>
      <strong>{a.fullName}</strong>
      <br />
      {[a.line1, a.line2, a.landmark].filter(Boolean).join(', ')}
      <br />
      {a.city}, {a.state} {a.pincode}
      <br />
      {a.phone}
    </address>
  );
}

const METHOD_LABEL = { upi: 'UPI', card: 'Card', netbanking: 'Net banking' } as const;

function StatusCard({ order }: { order: OrderDto }) {
  const copy = STATUS_COPY[order.status];
  const Icon = copy.tone === 'success' ? CheckCircle2 : copy.tone === 'danger' ? XCircle : copy.tone === 'warning' ? Clock : Package;
  const navigate = useNavigate();
  const start = useStartPayment();
  const lastFailure = order.latestPayment && ['FAILED', 'CANCELLED', 'EXPIRED'].includes(order.latestPayment.status) ? order.latestPayment : null;
  return (
    <section className={cx(styles.statusCard, styles[`tone-${copy.tone}`])} aria-label="Order status">
      <Icon size={28} strokeWidth={1.5} aria-hidden className={styles.statusIcon} />
      <div className={styles.statusBody}>
        <p className={styles.statusLabel}>{copy.label}</p>
        <p>
          {order.status === 'PAYMENT_FAILED' && lastFailure ? `${failureText(lastFailure.failureReason)} ` : ''}
          {copy.body}
        </p>
        {order.expectedDeliveryAt && !['CANCELLED', 'DELIVERED'].includes(order.status) ? (
          <p className="meta">Expected by {longDate(order.expectedDeliveryAt)}</p>
        ) : null}
        {order.refundedPaise > 0 ? <p className="meta">Refunded so far: {formatINR(order.refundedPaise)}</p> : null}
      </div>
      {order.canPay ? (
        <div className={styles.statusAction}>
          <Button
            loading={start.isPending}
            onClick={() =>
              start.mutate(
                { orderNumber: order.orderNumber, method: order.latestPayment?.method ?? 'upi' },
                { onSuccess: ({ attempt }) => navigate(`/checkout/pay/${attempt.id}`) },
              )
            }
          >
            Complete payment
          </Button>
          <FormError message={start.error ? errorMessage(start.error) : null} />
        </div>
      ) : null}
    </section>
  );
}

/** Full order view: used by the account and by guest signed links. */
export function OrderDetail({ order, token }: { order: OrderDto; token?: string | null }) {
  const steps = timelineFor(order);
  return (
    <div className={styles.stack}>
      <header className={styles.head}>
        <h1>Order {order.orderNumber}</h1>
        <p className="meta">Placed on {placedDate(order.placedAt)}</p>
      </header>
      <ExchangeNote order={order} token={token} />
      <StatusCard order={order} />
      <OrderActions order={order} token={token} />
      {steps ? (
        <section className={styles.panel} aria-label="Order progress">
          <OrderTimeline steps={steps} />
        </section>
      ) : null}
      <ShipmentPanel order={order} />
      <div className={styles.columns}>
        <section className={styles.panel} aria-labelledby="items-h">
          <h2 id="items-h" className={styles.panelTitle}>
            Items
          </h2>
          <OrderItems order={order} />
        </section>
        <div className={styles.side}>
          <section className={styles.panel} aria-labelledby="pay-h">
            <h2 id="pay-h" className={styles.panelTitle}>
              Payment
            </h2>
            <OrderTotals order={order} />
            {order.latestPayment?.status === 'SUCCEEDED' ? (
              <p className="meta">Paid by {METHOD_LABEL[order.latestPayment.method]}</p>
            ) : null}
            {order.kind === 'exchange' ? <p className="meta">No charge — this is an exchange.</p> : null}
            {order.pointsEarned > 0 ? (
              <p className={styles.points}>
                <Gift size={15} aria-hidden /> {order.pointsEarned} points pending — they become available after the return window.
              </p>
            ) : null}
          </section>
          <RefundsPanel order={order} />
          <ReturnsPanel order={order} token={token} />
          <section className={styles.panel} aria-labelledby="ship-h">
            <h2 id="ship-h" className={styles.panelTitle}>
              Delivery
            </h2>
            <AddressBlock order={order} />
            <p className="meta">{order.shippingMethod === 'express' ? 'Express delivery' : 'Standard delivery'}</p>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ---------------- /order/confirmed/:orderNumber ---------------- */

export function OrderConfirmedPage() {
  const { orderNumber } = useParams();
  const order = useOrder(orderNumber);
  const { data: user } = useMe();
  const qc = useQueryClient();
  // The bag was trimmed server-side when the payment succeeded.
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: cartKey });
  }, [qc]);

  if (order.isPending) {
    return (
      <main className={`container ${styles.page}`}>
        <PageSkeleton />
      </main>
    );
  }
  if (order.isError) {
    return (
      <main className="container">
        <ErrorState
          error={order.error}
          title="We couldn’t find this order"
          action={<ButtonLink to="/track">Find your order</ButtonLink>}
        />
      </main>
    );
  }

  const o = order.data;
  if (!['PAID', 'CONFIRMED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(o.status)) {
    return (
      <main className={`container ${styles.page}`}>
        <OrderDetail order={o} />
      </main>
    );
  }

  return (
    <main className={`container ${styles.page}`}>
      <section className={styles.thanks} aria-labelledby="thanks-h">
        <CheckCircle2 size={44} strokeWidth={1.4} className={styles.thanksIcon} aria-hidden />
        <p className="eyebrow">Order {o.orderNumber}</p>
        <h1 id="thanks-h">Thank you — your order is confirmed</h1>
        <p className={styles.thanksBody}>
          We’ve emailed the details to <strong>{o.email}</strong>.
          {o.expectedDeliveryAt ? <> Expected by <strong>{longDate(o.expectedDeliveryAt)}</strong>.</> : null}
        </p>
        <div className={styles.thanksActions}>
          <ButtonLink to={user && !o.isGuest ? `/account/orders/${o.orderNumber}` : '/track'} variant="secondary">
            {user && !o.isGuest ? 'View order' : 'Track your order'}
          </ButtonLink>
          <ButtonLink to="/">Continue shopping</ButtonLink>
        </div>
      </section>

      {o.isGuest && !user ? (
        <section className={styles.join}>
          <div>
            <h2 className={styles.panelTitle}>Save this order to an account</h2>
            <p className="meta">Create an account with {o.email} to track orders in one place and earn points on future purchases.</p>
          </div>
          <ButtonLink to={`/signup?email=${encodeURIComponent(o.email)}&returnTo=${encodeURIComponent('/account/orders')}`}>Create account</ButtonLink>
        </section>
      ) : null}

      <div className={styles.columns}>
        <section className={styles.panel} aria-labelledby="items-h">
          <h2 id="items-h" className={styles.panelTitle}>
            Your items
          </h2>
          <OrderItems order={o} />
        </section>
        <div className={styles.side}>
          <section className={styles.panel} aria-labelledby="sum-h">
            <h2 id="sum-h" className={styles.panelTitle}>
              Summary
            </h2>
            <OrderTotals order={o} />
            {o.pointsEarned > 0 ? (
              <p className={styles.points}>
                <Gift size={15} aria-hidden /> You’ll earn {o.pointsEarned} points once the return window closes.
              </p>
            ) : null}
          </section>
          <section className={styles.panel} aria-labelledby="ship-h">
            <h2 id="ship-h" className={styles.panelTitle}>
              Delivering to
            </h2>
            <AddressBlock order={o} />
          </section>
        </div>
      </div>
    </main>
  );
}

/* ---------------- /account/orders ---------------- */

export function AccountOrdersPage() {
  const orders = useOrders();
  const claim = useClaimOrders();
  return (
    <div className={styles.stack}>
      <header>
        <h1>Orders</h1>
      </header>
      {orders.data && orders.data.claimable > 0 ? (
        <div className={styles.claim} role="status">
          <p>
            We found {orders.data.claimable} {orders.data.claimable === 1 ? 'order' : 'orders'} placed with your email as a guest.
          </p>
          <Button size="sm" variant="secondary" loading={claim.isPending} onClick={() => claim.mutate()}>
            Add to my account
          </Button>
        </div>
      ) : null}
      {orders.isPending ? (
        <LoadingRegion label="Loading orders">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={96} radius="md" />
          ))}
        </LoadingRegion>
      ) : orders.isError ? (
        <ErrorState error={orders.error} action={<Button onClick={() => orders.refetch()}>Try again</Button>} />
      ) : orders.data.orders.length === 0 ? (
        <div className={styles.panel}>
          <EmptyState compact icon={Package} title="No orders yet" body="When you place an order, you can track it here." action={<ButtonLink to="/">Start shopping</ButtonLink>} />
        </div>
      ) : (
        <ul role="list" className={styles.list}>
          {orders.data.orders.map((o) => {
            const copy = STATUS_COPY[o.status];
            return (
              <li key={o.orderNumber}>
                <Link to={`/account/orders/${o.orderNumber}`} className={styles.row}>
                  <span className={styles.thumbs} aria-hidden>
                    {o.images.slice(0, 3).map((src) => (
                      <img key={src} src={src} alt="" loading="lazy" />
                    ))}
                  </span>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>{o.orderNumber}</span>
                    <span className="meta">
                      {placedDate(o.placedAt)} · {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'}
                    </span>
                  </span>
                  <Badge tone={copy.tone}>{copy.label}</Badge>
                  <span className={cx('tabular', styles.rowTotal)}>{formatINR(o.totalPaise)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---------------- /account/orders/:orderNumber ---------------- */

export function AccountOrderPage() {
  const { orderNumber } = useParams();
  const order = useOrder(orderNumber);
  if (order.isPending) return <PageSkeleton />;
  if (order.isError) {
    return <ErrorState error={order.error} title="We couldn’t find this order" action={<ButtonLink to="/account/orders">All orders</ButtonLink>} />;
  }
  return (
    <>
      <Link to="/account/orders" className={styles.backLink}>
        ← All orders
      </Link>
      <OrderDetail order={order.data} />
    </>
  );
}

/* ---------------- /track and /orders/:orderNumber?token= ---------------- */

export function TrackOrderPage() {
  const navigate = useNavigate();
  const lookup = useOrderLookup();
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const parsed = orderLookupSchema.safeParse({ orderNumber: form.get('orderNumber'), email: form.get('email') });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
      return setErrors(errs);
    }
    setErrors({});
    lookup.mutate(parsed.data, {
      onSuccess: ({ orderNumber, token }) => navigate(`/orders/${orderNumber}?token=${encodeURIComponent(token)}`),
    });
  };

  const message =
    lookup.error instanceof ApiError && lookup.error.code === 'RATE_LIMITED'
      ? 'Too many attempts. Please wait a minute and try again.'
      : lookup.error
        ? errorMessage(lookup.error)
        : null;

  return (
    <main className={`container ${styles.track}`}>
      <PackageSearch size={36} strokeWidth={1.4} aria-hidden className={styles.trackIcon} />
      <h1>Track your order</h1>
      <p className="meta">Enter the order number from your confirmation email and the email you used at checkout.</p>
      <form onSubmit={submit} noValidate className={styles.trackForm}>
        <Field label="Order number" name="orderNumber" placeholder="AV-2610-7K3QD" autoComplete="off" autoCapitalize="characters" error={errors.orderNumber} />
        <Field label="Email" name="email" type="email" autoComplete="email" error={errors.email} />
        <FormError message={message} />
        <Button type="submit" size="lg" fullWidth loading={lookup.isPending}>
          Find order
        </Button>
      </form>
      <p className="meta">
        Have an account? <Link to="/signin?returnTo=/account/orders">Sign in</Link> to see all your orders.
      </p>
    </main>
  );
}

export function GuestOrderPage() {
  const { orderNumber } = useParams();
  const [params] = useSearchParams();
  const order = useOrder(orderNumber, params.get('token'));
  return (
    <main className={`container ${styles.page}`}>
      {order.isPending ? (
        <PageSkeleton />
      ) : order.isError ? (
        <ErrorState
          error={order.error}
          title="This order link isn’t valid"
          action={<ButtonLink to="/track">Look up your order</ButtonLink>}
        />
      ) : (
        <OrderDetail order={order.data} token={params.get('token')} />
      )}
    </main>
  );
}
