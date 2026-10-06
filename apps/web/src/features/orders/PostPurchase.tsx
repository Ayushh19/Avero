import { CANCEL_REASONS, formatINR, type OrderDto } from '@avero/shared';
import { ArrowRightLeft, FileText, RotateCcw, Truck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Commerce';
import { Checkbox, FormError, SelectField } from '../../components/ui/Form';
import { Dialog, useToast } from '../../components/ui/Overlay';
import { errorMessage } from '../../lib/api';
import { REASON_COPY, REFUND_STATUS_COPY, RETURN_STATUS_COPY, dateTimeText, invoiceUrl, longDate, useCancelOrder, withToken } from './hooks';
import styles from './Orders.module.css';

/** Where the return flow and return details live for this viewer. */
export const returnFlowPath = (order: Pick<OrderDto, 'orderNumber' | 'isGuest'>, token?: string | null) =>
  order.isGuest ? withToken(`/orders/${order.orderNumber}/return`, token) : `/account/orders/${order.orderNumber}/return`;
export const returnPath = (rma: string, isGuest: boolean, token?: string | null) =>
  isGuest ? withToken(`/returns/${rma}`, token) : `/account/returns/${rma}`;

/* ---------------- actions ---------------- */

export function OrderActions({ order, token }: { order: OrderDto; token?: string | null }) {
  const [cancelling, setCancelling] = useState(false);
  if (!order.canCancel && !order.canReturn && !order.invoiceAvailable) return null;
  return (
    <div className={styles.actions}>
      {order.canReturn ? (
        <ButtonLink to={returnFlowPath(order, token)} variant="secondary" size="sm">
          <RotateCcw size={15} aria-hidden /> Return or exchange
        </ButtonLink>
      ) : null}
      {order.canCancel ? (
        <Button variant="secondary" size="sm" icon={<XCircle size={15} aria-hidden />} onClick={() => setCancelling(true)}>
          {order.items.filter((i) => i.cancellable).length > 1 ? 'Cancel items' : 'Cancel order'}
        </Button>
      ) : null}
      {order.invoiceAvailable ? (
        <a className={styles.textAction} href={invoiceUrl(order.orderNumber, token)} target="_blank" rel="noopener noreferrer">
          <FileText size={15} aria-hidden /> Invoice
        </a>
      ) : null}
      {order.returnWindowEndsAt && order.status === 'DELIVERED' ? (
        <p className="meta">
          {order.canReturn
            ? `Returns and exchanges open until ${longDate(order.returnWindowEndsAt)}`
            : new Date(order.returnWindowEndsAt) < new Date()
              ? `Return window closed on ${longDate(order.returnWindowEndsAt)}`
              : null}
        </p>
      ) : null}
      {order.canCancel ? (
        <CancelDialog
          key={order.items.filter((i) => i.cancellable).map((i) => i.id).join()}
          open={cancelling}
          onClose={() => setCancelling(false)}
          order={order}
          token={token}
        />
      ) : null}
    </div>
  );
}

function CancelDialog({ open, onClose, order, token }: { open: boolean; onClose: () => void; order: OrderDto; token?: string | null }) {
  const cancellable = order.items.filter((i) => i.cancellable);
  const [picked, setPicked] = useState<string[]>(() => cancellable.map((i) => i.id));
  const selected = picked.filter((id) => cancellable.some((i) => i.id === id));
  const setSelected = setPicked;
  const [reason, setReason] = useState('');
  const cancel = useCancelOrder(order.orderNumber, token);
  const toast = useToast();
  const all = selected.length === cancellable.length;
  const lines = cancellable.filter((i) => selected.includes(i.id));
  const refund = lines.reduce((s, i) => s + i.totalPaise, 0) + (all ? order.shippingPaise : 0);
  const points = order.pointsRedeemed > 0 ? Math.round(lines.reduce((s, i) => s + i.pointsDiscountPaise, 0) / 100) : 0;

  const submit = () =>
    cancel.mutate(
      { itemIds: all ? undefined : selected, reason },
      {
        onSuccess: () => {
          toast.success(all ? 'Your order has been cancelled' : `${selected.length} ${selected.length === 1 ? 'item' : 'items'} cancelled`);
          onClose();
        },
      },
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={cancellable.length > 1 ? 'Cancel items' : 'Cancel order'}
      footer={
        <div className={styles.dialogActions}>
          <Button variant="ghost" onClick={onClose}>
            Keep order
          </Button>
          <Button loading={cancel.isPending} disabled={!reason || selected.length === 0} onClick={submit}>
            {all ? 'Cancel order' : `Cancel ${selected.length} ${selected.length === 1 ? 'item' : 'items'}`}
          </Button>
        </div>
      }
    >
      <div className={styles.dialogBody}>
        {cancellable.length > 1 ? (
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>Items to cancel</legend>
            {cancellable.map((i) => (
              <Checkbox
                key={i.id}
                checked={selected.includes(i.id)}
                onChange={(e) => setSelected((s) => (e.target.checked ? [...s, i.id] : s.filter((x) => x !== i.id)))}
                label={
                  <>
                    {i.productName} · {i.colorName}, UK {i.sizeLabel} × {i.qty} <span className="meta tabular">{formatINR(i.totalPaise)}</span>
                  </>
                }
              />
            ))}
          </fieldset>
        ) : null}
        <SelectField label="Reason" name="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="" disabled>
            Choose a reason
          </option>
          {CANCEL_REASONS.map((r) => (
            <option key={r} value={r}>
              {REASON_COPY[r]}
            </option>
          ))}
        </SelectField>
        {selected.length > 0 ? (
          <p className={styles.dialogNote}>
            {refund > 0 ? <>We’ll refund <strong className="tabular">{formatINR(refund)}</strong> to your original payment method{all && order.shippingPaise > 0 ? ' (including delivery)' : ''}. </> : null}
            {points > 0 ? <>{points} points go back to your balance. </> : null}
            {!all && order.couponCode ? 'Your coupon stays applied to the rest of the order.' : null}
          </p>
        ) : null}
        <FormError message={cancel.error ? errorMessage(cancel.error) : null} />
      </div>
    </Dialog>
  );
}

/* ---------------- panels ---------------- */

export function ShipmentPanel({ order }: { order: OrderDto }) {
  const shipment = order.shipments.find((s) => s.kind === 'forward');
  if (!shipment) return null;
  return (
    <section className={styles.panel} aria-labelledby="track-h">
      <div className={styles.panelHead}>
        <h2 id="track-h" className={styles.panelTitle}>
          Tracking
        </h2>
        <p className="meta">
          <Truck size={14} aria-hidden /> {shipment.carrier} · <span className="tabular">{shipment.trackingNumber}</span>
        </p>
      </div>
      <ol role="list" className={styles.tracking}>
        {shipment.events.map((e, i) => (
          <li key={`${e.status}-${e.at}`} className={i === 0 ? styles.trackingLatest : undefined}>
            <span className={styles.trackingDot} aria-hidden />
            <span>
              <strong>{e.description}</strong>
              {e.location ? <span className="meta"> · {e.location}</span> : null}
              <br />
              <span className="meta">{dateTimeText(e.at)}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RefundsPanel({ order }: { order: OrderDto }) {
  if (order.refunds.length === 0) return null;
  return (
    <section className={styles.panel} aria-labelledby="refunds-h">
      <h2 id="refunds-h" className={styles.panelTitle}>
        Refunds
      </h2>
      <ul role="list" className={styles.refunds}>
        {order.refunds.map((r) => {
          const copy = REFUND_STATUS_COPY[r.status];
          return (
            <li key={r.id}>
              <span>
                <strong className="tabular">{r.amountPaise > 0 ? formatINR(r.amountPaise) : `${r.pointsAmount.toLocaleString('en-IN')} points`}</strong>
                <span className="meta">
                  {' '}
                  · {r.reason === 'return' ? 'Return' : r.reason === 'unfulfillable' ? 'Order couldn’t be fulfilled' : 'Cancellation'} ·{' '}
                  {r.destination === 'points' ? 'as AVERO points' : 'to original payment'}
                  {r.pointsAmount > 0 && r.amountPaise > 0 ? ` · ${r.pointsAmount} points returned` : ''}
                </span>
              </span>
              <Badge tone={copy.tone}>{copy.label}</Badge>
            </li>
          );
        })}
      </ul>
      {order.refunds.some((r) => r.status === 'FAILED') ? (
        <p className="meta">Your bank didn’t accept the refund yet. We retry automatically{order.isGuest ? '' : ' and will credit AVERO points if it keeps failing'}.</p>
      ) : null}
    </section>
  );
}

export function ReturnsPanel({ order, token }: { order: OrderDto; token?: string | null }) {
  if (order.returns.length === 0) return null;
  return (
    <section className={styles.panel} aria-labelledby="returns-h">
      <h2 id="returns-h" className={styles.panelTitle}>
        Returns & exchanges
      </h2>
      <ul role="list" className={styles.refunds}>
        {order.returns.map((r) => {
          const copy = RETURN_STATUS_COPY[r.status];
          return (
            <li key={r.rmaNumber}>
              <Link to={returnPath(r.rmaNumber, order.isGuest, token)}>
                {r.kind === 'exchange' ? <ArrowRightLeft size={14} aria-hidden /> : <RotateCcw size={14} aria-hidden />} {r.rmaNumber}
              </Link>
              <Badge tone={copy.tone}>{copy.label}</Badge>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ExchangeNote({ order, token }: { order: OrderDto; token?: string | null }) {
  if (order.kind !== 'exchange' || !order.parentOrderNumber) return null;
  const to = order.isGuest ? withToken(`/orders/${order.parentOrderNumber}`, token) : `/account/orders/${order.parentOrderNumber}`;
  return (
    <p className={styles.exchangeNote}>
      <ArrowRightLeft size={15} aria-hidden /> Free replacement from an exchange on order <Link to={to}>{order.parentOrderNumber}</Link>.
    </p>
  );
}
