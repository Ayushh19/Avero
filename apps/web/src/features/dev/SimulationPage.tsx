import { formatINR } from '@avero/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, FlaskConical, RotateCcw } from 'lucide-react';
import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Commerce';
import { EmptyState, Skeleton } from '../../components/ui/Feedback';
import { Field } from '../../components/ui/Form';
import { Tabs } from '../../components/ui/Nav';
import { Dialog, useToast } from '../../components/ui/Overlay';
import { api, errorMessage } from '../../lib/api';
import { usePublicConfig } from '../auth/hooks';
import { STATUS_COPY, RETURN_STATUS_COPY } from '../orders/hooks';
import styles from './Simulation.module.css';

/**
 * /dev/simulate — buttons for the dev simulation endpoints (SIMULATION_TOOLS=true only).
 * Not an admin panel: it drives the simulated world (clock, courier, gateway, catalogue) so every
 * scenario can be demonstrated without waiting days.
 */

interface DevState {
  now: string;
  offsetMs: number;
  jobs: { pending: number; due: number; failed: number };
  refundFailuresRemaining: number;
}
interface DevOrder {
  orderNumber: string;
  status: keyof typeof STATUS_COPY;
  kind: 'sale' | 'exchange';
  email: string;
  totalPaise: number;
  placedAt: string;
}
interface DevReturn {
  rmaNumber: string;
  status: keyof typeof RETURN_STATUS_COPY;
  kind: 'return' | 'exchange';
  orderNumber: string;
  createdAt: string;
}
interface DevSku {
  skuCode: string;
  sizeLabel: string;
  pricePaise: number;
  onHand: number;
  reserved: number;
  status: 'draft' | 'active' | 'discontinued';
  productName: string;
  colorName: string;
}
interface DevEmail {
  id: string;
  to: string;
  subject: string;
  text: string;
  template: string | null;
  createdAt: string;
}

const devKey = (k: string) => ['dev', k] as const;
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function useDev<T>(path: string, key: string, refetchInterval?: number) {
  return useQuery({ queryKey: devKey(key), queryFn: ({ signal }) => api.get<T>(path, signal), refetchInterval });
}

/** Runs a dev action, toasts the outcome and refreshes every panel view (time affects everything). */
function useAction<V>(fn: (v: V) => Promise<unknown>, done: (v: V) => string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_d, v) => {
      toast.success(done(v));
      // The worker picks up due jobs within ~0.5 s; refresh after it had a chance to run.
      void qc.invalidateQueries({ queryKey: ['dev'] });
      window.setTimeout(() => void qc.invalidateQueries(), 1200);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

export function SimulationPage() {
  const { data: config, isPending } = usePublicConfig();
  if (isPending) return null;
  if (!config?.simulationTools) {
    return (
      <main className="container">
        <EmptyState icon={FlaskConical} title="Simulation tools are off" body="Set SIMULATION_TOOLS=true for the API to use this panel." />
      </main>
    );
  }
  return (
    <main className={`container ${styles.page}`}>
      <header className={styles.head}>
        <p className="eyebrow">Developer</p>
        <h1>Simulation panel</h1>
        <p className="meta">Drive the simulated world — clock, courier, payment gateway and catalogue — to demonstrate any scenario. Changes affect everyone using this API.</p>
      </header>
      <ClockBar />
      <Tabs
        label="Simulation tools"
        items={[
          { id: 'orders', label: 'Orders & returns', content: <OrdersTab /> },
          { id: 'catalogue', label: 'Catalogue', content: <CatalogueTab /> },
          { id: 'customers', label: 'Customers', content: <CustomersTab /> },
          { id: 'emails', label: 'Emails', content: <EmailsTab /> },
        ]}
      />
    </main>
  );
}

/* ---------------- clock ---------------- */

const JUMPS: [string, number][] = [
  ['+1 hour', 60],
  ['+1 day', 24 * 60],
  ['+3 days', 3 * 24 * 60],
  ['+15 days', 15 * 24 * 60],
  ['+1 year', 365 * 24 * 60],
];

function offsetText(ms: number) {
  if (ms === 0) return 'real time';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.round((ms % 86_400_000) / 3_600_000);
  return `${days ? `${days} d ` : ''}${hours} h ahead`;
}

function ClockBar() {
  const state = useDev<DevState>('/dev/state', 'state', 3000);
  const [minutes, setMinutes] = useState('');
  const advance = useAction((m: number) => api.post('/dev/clock/advance', { minutes: m }), (m) => `Clock moved ${m >= 1440 ? `${Math.round(m / 1440)} day(s)` : `${m} min`} ahead`);
  const reset = useAction(() => api.post('/dev/clock/reset'), () => 'Clock back to real time');
  const s = state.data;
  return (
    <section className={styles.clock} aria-label="Simulated clock">
      <div className={styles.clockNow}>
        <Clock size={20} aria-hidden />
        <div>
          <p className={styles.clockTime}>{s ? new Date(s.now).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '…'}</p>
          <p className="meta">
            {s ? offsetText(s.offsetMs) : ''}
            {s ? ` · jobs: ${s.jobs.pending} scheduled, ${s.jobs.due} due${s.jobs.failed ? `, ${s.jobs.failed} failed` : ''}` : ''}
          </p>
        </div>
      </div>
      <div className={styles.clockActions}>
        {JUMPS.map(([label, m]) => (
          <Button key={label} size="sm" variant="secondary" onClick={() => advance.mutate(m)} disabled={advance.isPending}>
            {label}
          </Button>
        ))}
        <form
          className={styles.inline}
          onSubmit={(e) => {
            e.preventDefault();
            const m = Number(minutes);
            if (m > 0) advance.mutate(m);
          }}
        >
          <Field label="Minutes" name="minutes" type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} className={styles.small} />
          <Button type="submit" size="sm" variant="secondary" disabled={!Number(minutes)}>
            Advance
          </Button>
        </form>
        <Button size="sm" variant="ghost" icon={<RotateCcw size={14} aria-hidden />} onClick={() => reset.mutate(undefined)} disabled={!s?.offsetMs}>
          Reset
        </Button>
      </div>
    </section>
  );
}

/* ---------------- orders & returns ---------------- */

const ADVANCEABLE = ['CONFIRMED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY'];
const RETURN_ADVANCEABLE = ['PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED'];

function OrdersTab() {
  const orders = useDev<{ orders: DevOrder[] }>('/dev/orders', 'orders');
  const returns = useDev<{ returns: DevReturn[] }>('/dev/returns', 'returns');
  const state = useDev<DevState>('/dev/state', 'state');
  const [details, setDetails] = useState<string | null>(null);
  const [failures, setFailures] = useState('');
  const advance = useAction((n: string) => api.post<{ status: string }>(`/dev/orders/${n}/advance`), (n) => `${n} moved to the next step`);
  const advanceReturn = useAction((r: string) => api.post(`/dev/returns/${r}/advance`), (r) => `${r} moved to the next step`);
  const setMode = useAction((n: number) => api.post('/dev/refunds/failure-mode', { failures: n }), (n) => (n ? `The next ${n} bank refund(s) will fail` : 'Bank refunds succeed again'));

  return (
    <div className={styles.stack}>
      <Panel title="Orders" note="Advance moves an order one delivery step (packed → shipped → out for delivery → delivered).">
        {orders.isPending ? (
          <Skeleton height={120} />
        ) : orders.data?.orders.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Placed</th>
                <th className={styles.num}>Total</th>
                <th>Status</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.data.orders.map((o) => (
                <tr key={o.orderNumber}>
                  <td className={styles.mono}>
                    {o.orderNumber}
                    {o.kind === 'exchange' ? <span className="meta"> · exchange</span> : null}
                  </td>
                  <td>{o.email}</td>
                  <td>{when(o.placedAt)}</td>
                  <td className={styles.num}>{formatINR(o.totalPaise)}</td>
                  <td>
                    <Badge tone={STATUS_COPY[o.status].tone}>{STATUS_COPY[o.status].label}</Badge>
                  </td>
                  <td className={styles.rowActions}>
                    <Button size="sm" variant="secondary" disabled={!ADVANCEABLE.includes(o.status) || advance.isPending} onClick={() => advance.mutate(o.orderNumber)}>
                      Advance
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDetails(o.orderNumber)}>
                      Details
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="meta">No orders yet.</p>
        )}
      </Panel>

      <Panel title="Returns & exchanges" note="Advance: picked up → received → inspected and completed (refund or replacement).">
        {returns.data?.returns.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Return</th>
                <th>Order</th>
                <th>Requested</th>
                <th>Status</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {returns.data.returns.map((r) => (
                <tr key={r.rmaNumber}>
                  <td className={styles.mono}>
                    {r.rmaNumber}
                    <span className="meta"> · {r.kind}</span>
                  </td>
                  <td className={styles.mono}>{r.orderNumber}</td>
                  <td>{when(r.createdAt)}</td>
                  <td>
                    <Badge tone={RETURN_STATUS_COPY[r.status].tone}>{RETURN_STATUS_COPY[r.status].label}</Badge>
                  </td>
                  <td className={styles.rowActions}>
                    <Button size="sm" variant="secondary" disabled={!RETURN_ADVANCEABLE.includes(r.status) || advanceReturn.isPending} onClick={() => advanceReturn.mutate(r.rmaNumber)}>
                      Advance
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="meta">No returns yet.</p>
        )}
      </Panel>

      <Panel title="Payment gateway" note="Make the simulated bank reject refunds to see retries and the points fallback.">
        <form
          className={styles.inline}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setMode.mutate(Number(failures) || 0);
          }}
        >
          <Field label="Fail the next N refunds" name="failures" type="number" min={0} max={20} value={failures} onChange={(e) => setFailures(e.target.value)} className={styles.small} />
          <Button type="submit" size="sm" variant="secondary">
            Set
          </Button>
          <p className="meta">Currently: {state.data?.refundFailuresRemaining ?? 0} remaining</p>
        </form>
      </Panel>

      <OrderDetails orderNumber={details} onClose={() => setDetails(null)} />
    </div>
  );
}

interface DevOrderDetail {
  order: { status: string; email: string; totalPaise: number; paidPaise: number; refundedPaise: number };
  events: { type: string; toStatus: string | null; occurredAt: string }[];
  attempts: { status: string; method: string; failureReason: string | null }[];
  refunds: { amountPaise: number; status: string; destination: string; attempts: number }[];
}

function OrderDetails({ orderNumber, onClose }: { orderNumber: string | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['dev', 'order', orderNumber],
    queryFn: ({ signal }) => api.get<DevOrderDetail>(`/dev/orders/${orderNumber}`, signal),
    enabled: Boolean(orderNumber),
  });
  const d = detail.data;
  return (
    <Dialog open={Boolean(orderNumber)} onClose={onClose} title={orderNumber ?? ''} size="lg">
      {!d ? (
        <Skeleton height={160} />
      ) : (
        <div className={styles.stack}>
          <p>
            {d.order.status} · {d.order.email} · paid {formatINR(d.order.paidPaise)} · refunded {formatINR(d.order.refundedPaise)}
          </p>
          <h3 className={styles.subTitle}>Payments</h3>
          <ul className={styles.list}>
            {d.attempts.map((a, i) => (
              <li key={i}>
                {a.method.toUpperCase()} — {a.status}
                {a.failureReason ? ` (${a.failureReason})` : ''}
              </li>
            ))}
          </ul>
          {d.refunds.length ? (
            <>
              <h3 className={styles.subTitle}>Refunds</h3>
              <ul className={styles.list}>
                {d.refunds.map((r, i) => (
                  <li key={i}>
                    {formatINR(r.amountPaise)} → {r.destination} — {r.status} after {r.attempts} attempt(s)
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h3 className={styles.subTitle}>Events</h3>
          <ol className={styles.list}>
            {d.events.map((e, i) => (
              <li key={i}>
                <span className="meta">{when(e.occurredAt)}</span> {e.type}
                {e.toStatus ? ` → ${e.toStatus}` : ''}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Dialog>
  );
}

/* ---------------- catalogue ---------------- */

function CatalogueTab() {
  const list = useDev<{ skus: DevSku[] }>('/dev/skus', 'skus');
  const seed = useAction(() => api.post<{ reviews: number }>('/dev/reviews/seed'), () => 'Sample reviews seeded (products that already had them were skipped)');
  return (
    <div className={styles.stack}>
      <Panel title="Sizes" note="Lower a price to trigger price-drop alerts; restock a sold-out size to trigger back-in-stock alerts.">
        {list.isPending ? (
          <Skeleton height={200} />
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Product</th>
                <th>Size</th>
                <th className={styles.num}>Price (₹)</th>
                <th className={styles.num}>On hand</th>
                <th className={styles.num}>Reserved</th>
                <th>Status</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data?.skus.map((s) => <SkuRow key={s.skuCode} sku={s} />)}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Reviews" note="Adds verified sample reviews to products that have none from the sample reviewers.">
        <div>
          <Button size="sm" variant="secondary" loading={seed.isPending} onClick={() => seed.mutate(undefined)}>
            Seed sample reviews
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function SkuRow({ sku }: { sku: DevSku }) {
  const [price, setPrice] = useState(String(sku.pricePaise / 100));
  const [stock, setStock] = useState(String(sku.onHand));
  const [status, setStatus] = useState(sku.status === 'discontinued' ? 'discontinued' : 'active');
  const save = useAction(
    () =>
      api.post(`/dev/skus/${sku.skuCode}`, {
        ...(Math.round(Number(price) * 100) !== sku.pricePaise ? { pricePaise: Math.round(Number(price) * 100) } : {}),
        ...(Number(stock) !== sku.onHand ? { onHand: Number(stock) } : {}),
        ...(status !== sku.status ? { status } : {}),
      }),
    () => `${sku.productName} UK ${sku.sizeLabel} updated`,
  );
  const dirty = Math.round(Number(price) * 100) !== sku.pricePaise || Number(stock) !== sku.onHand || status !== sku.status;
  return (
    <tr>
      <td>
        {sku.productName}
        <span className="meta"> · {sku.colorName}</span>
      </td>
      <td>UK {sku.sizeLabel}</td>
      <td className={styles.num}>
        <input className={styles.cell} aria-label={`Price for UK ${sku.sizeLabel}`} type="number" min={1} step="1" value={price} onChange={(e) => setPrice(e.target.value)} />
      </td>
      <td className={styles.num}>
        <input className={styles.cell} aria-label={`Stock for UK ${sku.sizeLabel}`} type="number" min={0} value={stock} onChange={(e) => setStock(e.target.value)} />
      </td>
      <td className={styles.num}>{sku.reserved}</td>
      <td>
        <select className={styles.cell} aria-label={`Status for UK ${sku.sizeLabel}`} value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'discontinued')}>
          <option value="active">Active</option>
          <option value="discontinued">Discontinued</option>
        </select>
      </td>
      <td className={styles.rowActions}>
        <Button size="sm" variant="secondary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>
          Save
        </Button>
      </td>
    </tr>
  );
}

/* ---------------- customers ---------------- */

function CustomersTab() {
  const [email, setEmail] = useState('');
  const [points, setPoints] = useState('500');
  const [code, setCode] = useState('');
  const grant = useAction(() => api.post<{ balance: number }>('/dev/points/grant', { email, points: Number(points) }), () => `${points} points granted to ${email}`);
  const expire = useAction(() => api.post(`/dev/coupons/${encodeURIComponent(code.trim())}/expire`), () => `${code.toUpperCase()} now expired`);
  return (
    <div className={styles.grid}>
      <Panel title="Grant points" note="Available immediately and never expire (handy for testing redemption).">
        <form
          className={styles.stack}
          onSubmit={(e) => {
            e.preventDefault();
            grant.mutate(undefined);
          }}
        >
          <Field label="Member email" name="grant-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Field label="Points" name="grant-points" type="number" min={1} value={points} onChange={(e) => setPoints(e.target.value)} />
          <div>
            <Button type="submit" size="sm" loading={grant.isPending} disabled={!email || !Number(points)}>
              Grant points
            </Button>
          </div>
        </form>
      </Panel>
      <Panel title="Expire a coupon" note="Ends a coupon now — e.g. between a quote and placing the order.">
        <form
          className={styles.stack}
          onSubmit={(e) => {
            e.preventDefault();
            expire.mutate(undefined);
          }}
        >
          <Field label="Coupon code" name="expire-code" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" />
          <div>
            <Button type="submit" size="sm" variant="secondary" loading={expire.isPending} disabled={!code.trim()}>
              Expire now
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}

/* ---------------- emails ---------------- */

function linkify(text: string): ReactNode[] {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part.replace(/[).,]+$/, '')} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

function EmailsTab() {
  const emails = useDev<{ emails: DevEmail[] }>('/dev/emails', 'emails', 5000);
  const [open, setOpen] = useState<string | null>(null);
  if (emails.isPending) return <Skeleton height={200} />;
  const list = emails.data?.emails ?? [];
  return (
    <Panel title="Sent emails" note="Every email the app sent (newest first). Verification and password-reset links work from here.">
      {list.length === 0 ? (
        <p className="meta">No emails yet.</p>
      ) : (
        <ul className={styles.emails}>
          {list.map((m) => (
            <li key={m.id}>
              <button type="button" className={styles.emailHead} aria-expanded={open === m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>
                <strong>{m.subject}</strong>
                <span className="meta">
                  to {m.to} · {when(m.createdAt)}
                </span>
              </button>
              {open === m.id ? <p className={styles.emailBody}>{linkify(m.text)}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className={styles.panel} aria-label={title}>
      <div>
        <h2 className={styles.panelTitle}>{title}</h2>
        {note ? <p className="meta">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}
