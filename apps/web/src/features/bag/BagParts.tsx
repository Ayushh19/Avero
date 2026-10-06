import { formatINR, type CartDto, type CartLineDto } from '@avero/shared';
import { AlertCircle, Info, Lock } from 'lucide-react';
import { Link } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { QuantityStepper } from '../../components/ui/Commerce';
import { ProductMedia } from '../../components/ui/Merch';
import { cx } from '../../lib/cx';
import { useToggleWishlist } from '../wishlist/hooks';
import { useRemoveLine, useUpdateLine } from './hooks';
import styles from './BagParts.module.css';

function IssueBanner({ line }: { line: CartLineDto }) {
  const update = useUpdateLine();
  return (
    <>
      {line.issues.map((issue) => {
        switch (issue.type) {
          case 'unavailable':
            return (
              <p key={issue.type} className={cx(styles.issue, styles.issueBlocking)} role="alert">
                <AlertCircle size={15} aria-hidden /> This item is no longer available. Remove it to continue.
              </p>
            );
          case 'out_of_stock':
            return (
              <p key={issue.type} className={cx(styles.issue, styles.issueBlocking)} role="alert">
                <AlertCircle size={15} aria-hidden /> Size {line.sizeLabel} just sold out. Save it for later or remove it.
              </p>
            );
          case 'insufficient_stock':
            return (
              <p key={issue.type} className={styles.issue} role="status">
                <Info size={15} aria-hidden /> Only {issue.maxQty} left.
                <button type="button" className={styles.issueAction} onClick={() => update.mutate({ id: line.id, qty: issue.maxQty })}>
                  Update to {issue.maxQty}
                </button>
              </p>
            );
          case 'price_changed':
            return (
              <p key={issue.type} className={styles.issue} role="status">
                <Info size={15} aria-hidden />
                {issue.toPaise < issue.fromPaise ? 'Good news — the price dropped' : 'The price changed'} from {formatINR(issue.fromPaise)} to{' '}
                {formatINR(issue.toPaise)}.
              </p>
            );
        }
      })}
    </>
  );
}

export function BagLine({ line, compact }: { line: CartLineDto; compact?: boolean }) {
  const update = useUpdateLine();
  const remove = useRemoveLine();
  const wish = useToggleWishlist();
  const blocked = line.issues.some((i) => i.blocking);
  const busy = update.isPending || remove.isPending;

  const moveToWishlist = () => {
    wish.mutate(
      { item: { colorwayId: line.colorwayId, name: line.productName, pricePaise: line.unitPricePaise }, on: true },
      { onSuccess: () => remove.mutate(line.id) },
    );
  };

  return (
    <li className={cx(styles.line, compact && styles.compact, blocked && styles.blocked)} aria-busy={busy}>
      <Link to={line.href} className={styles.lineMedia} tabIndex={-1} aria-hidden>
        <ProductMedia image={line.image} alt="" radius="md" sizes="120px" />
      </Link>
      <div className={styles.lineBody}>
        <div className={styles.lineTop}>
          <div>
            <Link to={line.href} className={styles.lineName}>
              {line.productName}
            </Link>
            <p className="meta">
              {line.colorName} · Size {line.sizeLabel}
            </p>
          </div>
          <div className={styles.linePrice}>
            <span className="tabular">{formatINR(line.unitPricePaise * line.qty)}</span>
            {line.mrpPaise > line.unitPricePaise ? <s className="meta tabular">{formatINR(line.mrpPaise * line.qty)}</s> : null}
          </div>
        </div>
        <IssueBanner line={line} />
        <div className={styles.lineActions}>
          {line.savedForLater ? (
            <Button size="sm" variant="secondary" onClick={() => update.mutate({ id: line.id, savedForLater: false })} disabled={busy || blocked}>
              Move to bag
            </Button>
          ) : (
            <QuantityStepper
              value={line.qty}
              max={Math.max(line.maxQty, line.qty > line.maxQty ? line.qty : 1)}
              onChange={(qty) => update.mutate({ id: line.id, qty })}
              disabled={busy || blocked}
              label={`Quantity of ${line.productName}`}
            />
          )}
          <div className={styles.linkActions}>
            {!line.savedForLater ? (
              <button type="button" onClick={() => update.mutate({ id: line.id, savedForLater: true })} disabled={busy}>
                Save for later
              </button>
            ) : null}
            {!compact ? (
              <button type="button" onClick={moveToWishlist} disabled={busy}>
                Move to wishlist
              </button>
            ) : null}
            <button type="button" onClick={() => remove.mutate(line.id)} disabled={busy}>
              Remove
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

/** Progress towards free shipping; hidden when standard delivery is free on every order. */
export function FreeShippingProgress({ totals }: { totals: CartDto['totals'] }) {
  if (totals.subtotalPaise === 0 || totals.freeShippingThresholdPaise <= 0) return null;
  const pct = Math.min(100, Math.round((totals.subtotalPaise / totals.freeShippingThresholdPaise) * 100));
  return (
    <div className={styles.progress}>
      <p>
        {totals.freeShippingRemainingPaise > 0 ? (
          <>
            Add <strong>{formatINR(totals.freeShippingRemainingPaise)}</strong> more for free shipping
          </>
        ) : (
          <>You’ve unlocked free shipping</>
        )}
      </p>
      <div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progress to free shipping">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function BagSummary({ cart, checkoutLabel = 'Proceed to checkout' }: { cart: CartDto; checkoutLabel?: string }) {
  const t = cart.totals;
  return (
    <div className={styles.summary}>
      <dl className={styles.rows}>
        <div>
          <dt>Subtotal ({t.itemCount} {t.itemCount === 1 ? 'item' : 'items'})</dt>
          <dd className="tabular">{formatINR(t.subtotalPaise)}</dd>
        </div>
        {t.savingsPaise > 0 ? (
          <div className={styles.savings}>
            <dt>You save</dt>
            <dd className="tabular">−{formatINR(t.savingsPaise)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Shipping</dt>
          <dd className="tabular">{t.subtotalPaise === 0 ? '—' : t.shippingPaise === 0 ? 'Free' : formatINR(t.shippingPaise)}</dd>
        </div>
        <div className={styles.total}>
          <dt>Total</dt>
          <dd className="tabular">{formatINR(t.totalPaise)}</dd>
        </div>
      </dl>
      <p className="meta">Inclusive of all taxes (GST {formatINR(t.taxIncludedPaise)}). Coupons and rewards can be applied at checkout.</p>
      {cart.hasBlockingIssues ? (
        <p className={cx(styles.issue, styles.issueBlocking)} role="alert">
          <AlertCircle size={15} aria-hidden /> Some items need your attention before checkout.
        </p>
      ) : null}
      {t.itemCount > 0 && !cart.hasBlockingIssues ? (
        <ButtonLink to="/checkout" size="lg" fullWidth>
          <Lock size={16} aria-hidden /> {checkoutLabel}
        </ButtonLink>
      ) : (
        <Button size="lg" fullWidth disabled>
          {checkoutLabel}
        </Button>
      )}
    </div>
  );
}
