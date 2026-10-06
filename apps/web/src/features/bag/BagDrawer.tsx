import { formatINR } from '@avero/shared';
import { ShoppingBag } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/Feedback';
import { Drawer } from '../../components/ui/Overlay';
import { BagLine, FreeShippingProgress } from './BagParts';
import { BagUiContext, useCart } from './hooks';
import styles from './BagDrawer.module.css';

/** Provides `useBagUi().open()` and renders the mini-bag drawer. */
export function BagProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const [lastPath, setLastPath] = useState(location.pathname);
  if (location.pathname !== lastPath) {
    setLastPath(location.pathname);
    setOpen(false);
  }
  const value = useMemo(() => ({ open: () => setOpen(true) }), []);
  return (
    <BagUiContext.Provider value={value}>
      {children}
      <MiniBag open={open} onClose={() => setOpen(false)} />
    </BagUiContext.Provider>
  );
}

function MiniBag({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: cart } = useCart();
  const count = cart?.totals.itemCount ?? 0;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={count ? `Your bag (${count})` : 'Your bag'}
      footer={
        cart && cart.lines.length ? (
          <div className={styles.foot}>
            <div className={styles.subtotal}>
              <span>Subtotal</span>
              <strong className="tabular">{formatINR(cart.totals.subtotalPaise)}</strong>
            </div>
            <p className="meta">Shipping and discounts are calculated at checkout.</p>
            <ButtonLink to={cart.hasBlockingIssues ? '/bag' : '/checkout'} size="lg" fullWidth>
              {cart.hasBlockingIssues ? 'Review bag' : 'Checkout'}
            </ButtonLink>
            <ButtonLink to="/bag" variant="secondary" fullWidth>
              View bag
            </ButtonLink>
          </div>
        ) : null
      }
    >
      {!cart || cart.lines.length === 0 ? (
        <EmptyState
          compact
          icon={ShoppingBag}
          title="Your bag is empty"
          body="Find something you love — it will wait for you here."
          action={<Button onClick={onClose}>Continue shopping</Button>}
        />
      ) : (
        <div className={styles.body}>
          <FreeShippingProgress totals={cart.totals} />
          <ul role="list">
            {cart.lines.map((line) => (
              <BagLine key={line.id} line={line} compact />
            ))}
          </ul>
        </div>
      )}
    </Drawer>
  );
}
