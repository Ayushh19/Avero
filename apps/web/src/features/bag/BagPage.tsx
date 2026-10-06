import { ShoppingBag, Truck, RefreshCcw, ShieldCheck } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '../../components/ui/Feedback';
import { TrustRow } from '../../components/ui/Merch';
import { useMe, usePublicConfig } from '../auth/hooks';
import { RecentlyViewedRail } from '../recent/recentlyViewed';
import { deliveryPromise } from '../../lib/shipping';
import { BagLine, BagSummary, FreeShippingProgress } from './BagParts';
import { useAcknowledgePrices, useCart } from './hooks';
import { BagSuggestions } from './BagSuggestions';
import styles from './BagPage.module.css';

export function BagPage() {
  const cart = useCart();
  const { data: user } = useMe();
  const { data: config } = usePublicConfig();
  const ack = useAcknowledgePrices();
  const hadPriceNotice = useRef(false);

  // Price-change notices are shown for this visit, then marked as seen.
  const priceNotice = cart.data?.lines.some((l) => l.issues.some((i) => i.type === 'price_changed'));
  useEffect(() => {
    if (priceNotice) hadPriceNotice.current = true;
  }, [priceNotice]);
  const ackMutate = ack.mutate;
  useEffect(() => () => {
    if (hadPriceNotice.current) ackMutate();
  }, [ackMutate]);

  if (cart.isPending) {
    return (
      <main className={`container ${styles.page}`}>
        <LoadingRegion label="Loading your bag">
          <Skeleton width={220} height={36} />
          <div className={styles.layout}>
            <div className={styles.lines}>
              {[0, 1].map((i) => (
                <Skeleton key={i} height={140} radius="md" />
              ))}
            </div>
            <Skeleton height={280} radius="md" />
          </div>
        </LoadingRegion>
      </main>
    );
  }

  if (cart.isError) {
    return (
      <main className="container">
        <ErrorState error={cart.error} title="We couldn’t load your bag" action={<Button onClick={() => cart.refetch()}>Try again</Button>} />
      </main>
    );
  }

  const data = cart.data;
  const empty = data.lines.length === 0;

  return (
    <main className={`container ${styles.page}`}>
      <h1>
        Your bag {data.totals.itemCount ? <span className={styles.count}>({data.totals.itemCount} {data.totals.itemCount === 1 ? 'item' : 'items'})</span> : null}
      </h1>

      {empty ? (
        <EmptyState
          icon={ShoppingBag}
          title="Your bag is empty"
          body={data.savedForLater.length ? 'You have items saved for later below.' : 'Find something you love — it will wait for you here.'}
          action={
            <>
              <ButtonLink to="/collections/new-arrivals">Shop new arrivals</ButtonLink>
              {!user ? (
                <ButtonLink to="/signin?returnTo=/bag" variant="secondary">
                  Sign in to see your saved bag
                </ButtonLink>
              ) : null}
            </>
          }
        />
      ) : (
        <div className={styles.layout}>
          <section aria-label="Items in your bag" className={styles.lines}>
            <FreeShippingProgress totals={data.totals} />
            <ul role="list">
              {data.lines.map((line) => (
                <BagLine key={line.id} line={line} />
              ))}
            </ul>
            <TrustRow
              items={[
                { icon: Truck, ...deliveryPromise(data.totals.freeShippingThresholdPaise) },
                { icon: RefreshCcw, title: 'Easy returns', body: `Within ${config?.returnWindowDays ?? 15} days of delivery` },
                { icon: ShieldCheck, title: 'Secure checkout', body: 'Payments are simulated — no real money' },
              ]}
            />
          </section>
          <aside className={styles.summary} aria-label="Order summary">
            <h2 className={styles.summaryTitle}>Order summary</h2>
            <BagSummary cart={data} />
            {!user ? (
              <p className="meta">
                No account needed — you can check out as a guest. <Link to="/signin?returnTo=/checkout">Sign in</Link> to use saved addresses and rewards.
              </p>
            ) : null}
          </aside>
        </div>
      )}

      {!empty ? <BagSuggestions slugs={data.lines.map((l) => l.productSlug)} /> : null}

      {data.savedForLater.length ? (
        <section className={styles.saved} aria-label="Saved for later">
          <h2>Saved for later ({data.savedForLater.length})</h2>
          <ul role="list">
            {data.savedForLater.map((line) => (
              <BagLine key={line.id} line={line} />
            ))}
          </ul>
        </section>
      ) : null}

      <div className="section">
        <RecentlyViewedRail />
      </div>
    </main>
  );
}
