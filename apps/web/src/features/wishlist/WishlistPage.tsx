import { formatINR } from '@avero/shared';
import { Heart } from 'lucide-react';
import { Link } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Commerce';
import { EmptyState, ErrorState, LoadingRegion, ProductCardSkeleton } from '../../components/ui/Feedback';
import { ProductCard, ProductGrid } from '../../components/ui/Merch';
import { useMe } from '../auth/hooks';
import { useWishlist } from './hooks';
import { WishlistCardButton } from './WishlistButton';
import styles from './WishlistPage.module.css';

export function WishlistContent() {
  const { data: user } = useMe();
  const wishlist = useWishlist();

  if (wishlist.isPending) {
    return (
      <LoadingRegion label="Loading wishlist">
        <ProductGrid columns={4}>
          {[0, 1, 2, 3].map((i) => (
            <li key={i}>
              <ProductCardSkeleton />
            </li>
          ))}
        </ProductGrid>
      </LoadingRegion>
    );
  }
  if (wishlist.isError) return <ErrorState error={wishlist.error} action={<Button onClick={() => wishlist.refetch()}>Try again</Button>} />;
  if (wishlist.data.length === 0) {
    return (
      <EmptyState
        icon={Heart}
        title="Your wishlist is empty"
        body="Tap the heart on any product to save it here. We’ll let you know when saved styles drop in price."
        action={<ButtonLink to="/collections/new-arrivals">Discover new arrivals</ButtonLink>}
      />
    );
  }

  return (
    <div className={styles.stack}>
      {!user ? (
        <p className={styles.note}>
          Your wishlist is saved on this device. <Link to="/signin?returnTo=/wishlist">Sign in</Link> to keep it across devices.
        </p>
      ) : null}
      <ProductGrid columns={4}>
        {wishlist.data.map((item) => {
          const dropped = item.addedPricePaise !== null && item.pricePaise < item.addedPricePaise;
          return (
            <li key={item.colorwayId} className={styles.item}>
              <ProductCard
                product={{ ...item, badge: dropped ? 'Price drop' : item.badge }}
                sizes="(min-width: 1280px) 22vw, (min-width: 768px) 30vw, 50vw"
                wishlistButton={<WishlistCardButton item={item} />}
              />
              {dropped ? (
                <p className={styles.signal}>
                  <Badge tone="success">Now {formatINR(item.pricePaise)}</Badge>
                  <span className="meta">was {formatINR(item.addedPricePaise!)} when saved</span>
                </p>
              ) : !item.inStock ? (
                <p className="meta">Sold out — open it to get notified when your size is back.</p>
              ) : null}
            </li>
          );
        })}
      </ProductGrid>
    </div>
  );
}

export function WishlistPage() {
  return (
    <main className={`container ${styles.page}`}>
      <h1>Wishlist</h1>
      <WishlistContent />
    </main>
  );
}
