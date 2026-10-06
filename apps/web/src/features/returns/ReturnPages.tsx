import { RETURN_REASONS, formatINR, type CreateReturnInput, type ReturnDto, type ReturnOptionItemDto } from '@avero/shared';
import { ArrowRightLeft, CheckCircle2, PackageOpen, RotateCcw, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Commerce';
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '../../components/ui/Feedback';
import { Checkbox, FormError, RadioCard, SelectField, TextareaField } from '../../components/ui/Form';
import { ProductMedia } from '../../components/ui/Merch';
import { OrderTimeline, type TimelineStep } from '../../components/ui/Nav';
import { Dialog, useToast } from '../../components/ui/Overlay';
import { ApiError, errorMessage } from '../../lib/api';
import { cx } from '../../lib/cx';
import { REASON_COPY, REFUND_STATUS_COPY, RETURN_STATUS_COPY, dateTimeText, longDate, withToken } from '../orders/hooks';
import { returnPath } from '../orders/PostPurchase';
import { useCancelReturn, useCreateReturn, useReturn, useReturnOptions, useReturns } from './hooks';
import styles from './Returns.module.css';
import { singleImage } from '../../lib/images';

/* ---------------- request: /account/orders/:n/return and /orders/:n/return?token= ---------------- */

interface Choice {
  reason: string;
  comment: string;
  exchangeSkuId: string;
}

export function ReturnRequestPage({ guest = false }: { guest?: boolean }) {
  const { orderNumber } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token');
  const options = useReturnOptions(orderNumber, token);
  const body = (() => {
    if (options.isPending) {
      return (
        <LoadingRegion label="Loading return options">
          <Skeleton width="40%" height={36} />
          <Skeleton height={320} radius="md" />
        </LoadingRegion>
      );
    }
    if (options.isError) {
      return <ErrorState error={options.error} title="We couldn’t load this order" action={<ButtonLink to={guest ? '/track' : '/account/orders'}>Back to orders</ButtonLink>} />;
    }
    return <ReturnForm data={options.data} token={token} refetch={() => void options.refetch()} />;
  })();
  return guest ? <main className={`container ${styles.page}`}>{body}</main> : <div className={styles.page}>{body}</div>;
}

function ReturnForm({ data, token, refetch }: { data: NonNullable<ReturnType<typeof useReturnOptions>['data']>; token: string | null; refetch: () => void }) {
  const navigate = useNavigate();
  const create = useCreateReturn(token);
  const [kind, setKind] = useState<'return' | 'exchange'>('return');
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [destination, setDestination] = useState<'original' | 'points'>('original');
  const [problem, setProblem] = useState<string | null>(null);
  const isGuest = !data.pointsRefundAllowed;
  const orderPath = isGuest ? withToken(`/orders/${data.orderNumber}`, token) : `/account/orders/${data.orderNumber}`;
  const returnable = data.items.filter((i) => i.returnable);

  if (returnable.length === 0) {
    return (
      <EmptyState
        icon={PackageOpen}
        title="Nothing to return on this order"
        body={data.items[0]?.reason ?? 'None of these items can be returned right now.'}
        action={<ButtonLink to={orderPath}>Back to order</ButtonLink>}
      />
    );
  }

  const exchangeable = (i: ReturnOptionItemDto) => i.exchangeOptions.some((o) => o.available);
  const selectable = (i: ReturnOptionItemDto) => i.returnable && (kind === 'return' || exchangeable(i));
  const selected = Object.entries(choices).filter(([id]) => {
    const item = data.items.find((i) => i.orderItemId === id);
    return item && selectable(item);
  });
  const refund = selected.reduce((s, [id]) => s + (data.items.find((i) => i.orderItemId === id)?.totalPaise ?? 0), 0);
  const incomplete = selected.some(([, c]) => !c.reason || (kind === 'exchange' && !c.exchangeSkuId));

  const toggle = (id: string, on: boolean) =>
    setChoices((c) => {
      const next = { ...c };
      if (on) next[id] = { reason: '', comment: '', exchangeSkuId: '' };
      else delete next[id];
      return next;
    });
  const update = (id: string, patch: Partial<Choice>) => setChoices((c) => ({ ...c, [id]: { ...c[id]!, ...patch } }));

  const submit = () => {
    setProblem(null);
    const input: CreateReturnInput = {
      orderNumber: data.orderNumber,
      kind,
      refundDestination: kind === 'return' ? destination : 'original',
      items: selected.map(([orderItemId, c]) => ({
        orderItemId,
        reason: c.reason as CreateReturnInput['items'][number]['reason'],
        comment: c.comment.trim() || undefined,
        exchangeSkuId: kind === 'exchange' ? c.exchangeSkuId : undefined,
      })),
    };
    create.mutate(input, {
      onSuccess: ({ return: ret }) => navigate(returnPath(ret.rmaNumber, isGuest, token), { replace: true }),
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'EXCHANGE_UNAVAILABLE') refetch();
        setProblem(errorMessage(err));
      },
    });
  };

  return (
    <>
      <header className={styles.head}>
        <Link to={orderPath} className={styles.back}>
          ← Order {data.orderNumber}
        </Link>
        <h1>Return or exchange</h1>
        {data.windowEndsAt ? <p className="meta">Open until {longDate(data.windowEndsAt)}. We’ll collect from your delivery address.</p> : null}
      </header>

      <div className={styles.layout}>
        <div className={styles.main}>
          <section className={styles.panel} aria-labelledby="kind-h">
            <h2 id="kind-h" className={styles.panelTitle}>
              What would you like?
            </h2>
            <div className={styles.kinds} role="radiogroup" aria-labelledby="kind-h">
              <RadioCard name="kind" value="return" checked={kind === 'return'} onChange={() => setKind('return')} title="Return for a refund" description="Shipping isn’t refunded" />
              <RadioCard
                name="kind"
                value="exchange"
                checked={kind === 'exchange'}
                onChange={() => setKind('exchange')}
                title="Exchange"
                description="Another size or colour, same price, free"
              />
            </div>
          </section>

          <section className={styles.panel} aria-labelledby="items-h">
            <h2 id="items-h" className={styles.panelTitle}>
              Which items?
            </h2>
            <ul role="list" className={styles.items}>
              {data.items.map((item) => {
                const can = selectable(item);
                const choice = choices[item.orderItemId];
                const on = Boolean(choice) && can;
                const why = !item.returnable ? item.reason : kind === 'exchange' && !exchangeable(item) ? 'No other size or colour at this price is in stock — choose a return instead' : null;
                return (
                  <li key={item.orderItemId} className={cx(styles.item, !can && styles.itemDisabled)}>
                    <div className={styles.itemTop}>
                      <span className={styles.itemMedia}>
                        <ProductMedia image={singleImage(item.imageUrl)} alt="" radius="md" sizes="72px" />
                      </span>
                      <div className={styles.itemText}>
                        <Checkbox
                          checked={on}
                          disabled={!can}
                          onChange={(e) => toggle(item.orderItemId, e.target.checked)}
                          label={
                            <span>
                              <strong>{item.productName}</strong>
                              <br />
                              <span className="meta">
                                {item.colorName} · UK {item.sizeLabel} · Qty {item.qty} · {formatINR(item.totalPaise)}
                              </span>
                            </span>
                          }
                        />
                        {why ? <p className={styles.why}>{why}</p> : null}
                      </div>
                    </div>
                    {on ? (
                      <div className={styles.itemFields}>
                        {kind === 'exchange' ? (
                          <SelectField
                            label="Exchange for"
                            name={`ex-${item.orderItemId}`}
                            value={choice!.exchangeSkuId}
                            onChange={(e) => update(item.orderItemId, { exchangeSkuId: e.target.value })}
                          >
                            <option value="" disabled>
                              Choose a size or colour
                            </option>
                            {item.exchangeOptions.map((o) => (
                              <option key={o.skuId} value={o.skuId} disabled={!o.available}>
                                {o.colorName} · UK {o.sizeLabel}
                                {o.available ? '' : ' — sold out'}
                              </option>
                            ))}
                          </SelectField>
                        ) : null}
                        <SelectField label="Reason" name={`reason-${item.orderItemId}`} value={choice!.reason} onChange={(e) => update(item.orderItemId, { reason: e.target.value })}>
                          <option value="" disabled>
                            Choose a reason
                          </option>
                          {RETURN_REASONS.map((r) => (
                            <option key={r} value={r}>
                              {REASON_COPY[r]}
                            </option>
                          ))}
                        </SelectField>
                        <TextareaField
                          label="Anything else? (optional)"
                          name={`comment-${item.orderItemId}`}
                          rows={2}
                          maxLength={500}
                          value={choice!.comment}
                          onChange={(e) => update(item.orderItemId, { comment: e.target.value })}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>

          {kind === 'return' ? (
            <section className={styles.panel} aria-labelledby="dest-h">
              <h2 id="dest-h" className={styles.panelTitle}>
                Refund to
              </h2>
              <div className={styles.kinds} role="radiogroup" aria-labelledby="dest-h">
                <RadioCard
                  name="destination"
                  value="original"
                  checked={destination === 'original'}
                  onChange={() => setDestination('original')}
                  title="Original payment method"
                  description="5–7 business days after inspection"
                />
                <RadioCard
                  name="destination"
                  value="points"
                  checked={destination === 'points'}
                  disabled={isGuest}
                  onChange={() => setDestination('points')}
                  title="AVERO points"
                  description={isGuest ? 'Needs an AVERO account' : 'Instant after inspection · 1 point = ₹1'}
                />
              </div>
            </section>
          ) : null}
        </div>

        <aside className={styles.summary} aria-label="Summary">
          <h2 className={styles.panelTitle}>Summary</h2>
          <p>
            {selected.length === 0
              ? 'Select the items you want to send back.'
              : `${selected.length} ${selected.length === 1 ? 'item' : 'items'} to ${kind === 'exchange' ? 'exchange' : 'return'}`}
          </p>
          {selected.length > 0 ? (
            kind === 'return' ? (
              <p className={styles.amount}>
                Refund <strong className="tabular">{formatINR(refund)}</strong>
                {destination === 'points' ? <span className="meta"> as {Math.ceil(refund / 100).toLocaleString('en-IN')} points</span> : null}
              </p>
            ) : (
              <p className={styles.amount}>No charge for the replacement</p>
            )
          ) : null}
          <p className="meta">Pickup is booked for tomorrow. Keep the shoes in their original box with tags attached.</p>
          <FormError message={problem} />
          <Button size="lg" fullWidth loading={create.isPending} disabled={selected.length === 0 || incomplete} onClick={submit}>
            {kind === 'exchange' ? 'Request exchange' : 'Request return'}
          </Button>
          {incomplete && selected.length > 0 ? <p className="meta">Choose a reason{kind === 'exchange' ? ' and a replacement' : ''} for each item.</p> : null}
        </aside>
      </div>
    </>
  );
}

/* ---------------- /account/returns ---------------- */

export function AccountReturnsPage() {
  const returns = useReturns();
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>Returns</h1>
      </header>
      {returns.isPending ? (
        <LoadingRegion label="Loading returns">
          <Skeleton height={80} radius="md" />
        </LoadingRegion>
      ) : returns.isError ? (
        <ErrorState error={returns.error} action={<Button onClick={() => returns.refetch()}>Try again</Button>} />
      ) : returns.data.length === 0 ? (
        <div className={styles.panel}>
          <EmptyState compact icon={RotateCcw} title="No returns" body="Start a return or exchange from a delivered order." action={<ButtonLink to="/account/orders">Your orders</ButtonLink>} />
        </div>
      ) : (
        <ul role="list" className={styles.list}>
          {returns.data.map((r) => {
            const copy = RETURN_STATUS_COPY[r.status];
            return (
              <li key={r.rmaNumber}>
                <Link to={`/account/returns/${r.rmaNumber}`} className={styles.row}>
                  {r.kind === 'exchange' ? <ArrowRightLeft size={20} strokeWidth={1.5} aria-hidden /> : <RotateCcw size={20} strokeWidth={1.5} aria-hidden />}
                  <span className={styles.rowMain}>
                    <strong>{r.rmaNumber}</strong>
                    <span className="meta">
                      {r.kind === 'exchange' ? 'Exchange' : 'Return'} · order {r.orderNumber} · {r.itemCount} {r.itemCount === 1 ? 'item' : 'items'} ·{' '}
                      {longDate(r.createdAt)}
                    </span>
                  </span>
                  <Badge tone={copy.tone}>{copy.label}</Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---------------- detail: /account/returns/:rma and /returns/:rma?token= ---------------- */

const STEPS: { status: ReturnDto['status']; label: string }[] = [
  { status: 'PICKUP_SCHEDULED', label: 'Pickup booked' },
  { status: 'PICKED_UP', label: 'Picked up' },
  { status: 'RECEIVED', label: 'Received' },
  { status: 'INSPECTED', label: 'Inspected' },
  { status: 'COMPLETED', label: 'Done' },
];

function returnTimeline(ret: ReturnDto): TimelineStep[] {
  const reached = new Map(ret.timeline.map((t) => [t.status, t.at]));
  const current = STEPS.findIndex((s) => s.status === ret.status);
  return STEPS.map((s, i) => ({
    label: s.status === 'COMPLETED' ? (ret.kind === 'exchange' ? 'Replacement created' : 'Refund issued') : s.label,
    at: reached.get(s.status) ? dateTimeText(reached.get(s.status)!) : undefined,
    state: i < current ? 'done' : i === current ? 'current' : 'upcoming',
  }));
}

export function ReturnDetailPage({ guest = false }: { guest?: boolean }) {
  const { rma } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token');
  const ret = useReturn(rma, token);
  const body = ret.isPending ? (
    <LoadingRegion label="Loading return">
      <Skeleton width="40%" height={36} />
      <Skeleton height={240} radius="md" />
    </LoadingRegion>
  ) : ret.isError ? (
    <ErrorState error={ret.error} title="We couldn’t find this return" action={<ButtonLink to={guest ? '/track' : '/account/returns'}>{guest ? 'Find your order' : 'All returns'}</ButtonLink>} />
  ) : (
    <ReturnDetail ret={ret.data} token={token} guest={guest} />
  );
  return guest ? <main className={`container ${styles.page}`}>{body}</main> : <div className={styles.page}>{body}</div>;
}

function ReturnDetail({ ret, token, guest }: { ret: ReturnDto; token: string | null; guest: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const cancel = useCancelReturn(ret.rmaNumber, token);
  const toast = useToast();
  const copy = RETURN_STATUS_COPY[ret.status];
  const orderPath = guest ? withToken(`/orders/${ret.orderNumber}`, token) : `/account/orders/${ret.orderNumber}`;
  const replacementPath = ret.replacementOrderNumber
    ? guest
      ? withToken(`/orders/${ret.replacementOrderNumber}`, token)
      : `/account/orders/${ret.replacementOrderNumber}`
    : null;
  const refundCopy = ret.refund ? REFUND_STATUS_COPY[ret.refund.status] : null;

  return (
    <>
      <header className={styles.head}>
        {!guest ? (
          <Link to="/account/returns" className={styles.back}>
            ← All returns
          </Link>
        ) : null}
        <h1>
          {ret.kind === 'exchange' ? 'Exchange' : 'Return'} {ret.rmaNumber}
        </h1>
        <p className="meta">
          For order <Link to={orderPath}>{ret.orderNumber}</Link> · requested {longDate(ret.createdAt)}
        </p>
      </header>

      <section className={cx(styles.status, ret.status === 'CANCELLED' && styles.statusMuted)} aria-label="Status">
        {ret.status === 'COMPLETED' ? <CheckCircle2 size={26} strokeWidth={1.5} aria-hidden /> : ret.status === 'CANCELLED' ? <XCircle size={26} strokeWidth={1.5} aria-hidden /> : <PackageOpen size={26} strokeWidth={1.5} aria-hidden />}
        <div>
          <p className={styles.statusLabel}>{copy.label}</p>
          <p>{statusBody(ret)}</p>
        </div>
        {ret.canCancel ? (
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            Cancel {ret.kind}
          </Button>
        ) : null}
      </section>

      {ret.status !== 'CANCELLED' ? (
        <section className={styles.panel} aria-label="Return progress">
          <OrderTimeline steps={returnTimeline(ret)} />
        </section>
      ) : null}

      <div className={styles.layout}>
        <section className={styles.panel} aria-labelledby="ret-items-h">
          <h2 id="ret-items-h" className={styles.panelTitle}>
            Items
          </h2>
          <ul role="list" className={styles.items}>
            {ret.items.map((i) => (
              <li key={i.orderItemId} className={styles.itemTop}>
                <span className={styles.itemMedia}>
                  <ProductMedia image={singleImage(i.imageUrl)} alt="" radius="md" sizes="72px" />
                </span>
                <span className={styles.itemText}>
                  <strong>{i.productName}</strong>
                  <span className="meta">
                    {i.colorName} · UK {i.sizeLabel} · Qty {i.qty}
                  </span>
                  {i.exchangeFor ? (
                    <span className={styles.exchangeFor}>
                      <ArrowRightLeft size={14} aria-hidden /> {i.exchangeFor.colorName} · UK {i.exchangeFor.sizeLabel}
                    </span>
                  ) : null}
                  <span className="meta">
                    {REASON_COPY[i.reason] ?? i.reason}
                    {i.comment ? ` — “${i.comment}”` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <aside className={styles.summary} aria-label={ret.kind === 'exchange' ? 'Replacement' : 'Refund'}>
          {ret.kind === 'return' ? (
            <>
              <h2 className={styles.panelTitle}>Refund</h2>
              <p className={styles.amount}>
                <strong className="tabular">{formatINR(ret.refund?.amountPaise ?? ret.refundPaise)}</strong>
                <span className="meta"> {ret.refundDestination === 'points' ? `as ${Math.ceil((ret.refund?.amountPaise ?? ret.refundPaise) / 100).toLocaleString('en-IN')} AVERO points` : 'to your original payment method'}</span>
              </p>
              {refundCopy ? <Badge tone={refundCopy.tone}>{refundCopy.label}</Badge> : <p className="meta">Starts once the item passes inspection. Shipping isn’t refunded.</p>}
              {ret.refund?.status === 'FAILED' ? <p className="meta">Your bank didn’t accept it yet — we’re retrying automatically.</p> : null}
            </>
          ) : (
            <>
              <h2 className={styles.panelTitle}>Replacement</h2>
              {replacementPath ? (
                <p>
                  Order <Link to={replacementPath}>{ret.replacementOrderNumber}</Link> is on its way at no cost.
                </p>
              ) : (
                <p className="meta">We’ve set your replacement aside. It ships as soon as your return passes inspection.</p>
              )}
            </>
          )}
        </aside>
      </div>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Cancel this ${ret.kind}?`}
        footer={
          <div className={styles.dialogActions}>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              loading={cancel.isPending}
              onClick={() =>
                cancel.mutate(undefined, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast.success(`${ret.rmaNumber} cancelled`);
                  },
                })
              }
            >
              Cancel {ret.kind}
            </Button>
          </div>
        }
      >
        <p>The pickup will be called off and the items stay with you.{ret.kind === 'exchange' ? ' The replacement we set aside goes back on sale.' : ''}</p>
        <FormError message={cancel.error ? errorMessage(cancel.error) : null} />
      </Dialog>
    </>
  );
}

function statusBody(ret: ReturnDto): string {
  switch (ret.status) {
    case 'REQUESTED':
    case 'PICKUP_SCHEDULED':
      return 'Our courier will collect the parcel from your delivery address. Keep the shoes in their box with tags attached.';
    case 'PICKED_UP':
      return 'Your parcel is on its way back to us.';
    case 'RECEIVED':
    case 'INSPECTED':
      return 'We’ve received your parcel and are checking it.';
    case 'COMPLETED':
      return ret.kind === 'exchange' ? 'Your replacement has been sent.' : 'Your return is complete.';
    case 'CANCELLED':
      return 'You cancelled this request. The items stayed with you.';
  }
}
