import type { ListingItemDto } from '@avero/shared';
import { Button, ButtonLink } from '../../components/ui/Button';
import { ErrorState, ProductCardSkeleton, Skeleton } from '../../components/ui/Feedback';
import { CollectionTile, EditorialSection, Hero, ProductCard, ProductGrid } from '../../components/ui/Merch';
import { Tabs } from '../../components/ui/Nav';
import { useHome } from '../../lib/catalog';
import { PersonalRows } from './PersonalRows';
import { RecentlyViewedRail } from '../recent/recentlyViewed';
import { WishlistCardButton } from '../wishlist/WishlistButton';
import styles from './HomePage.module.css';

const CARD_SIZES = '(min-width: 1280px) 22vw, (min-width: 768px) 30vw, 50vw';

function Showcase({ items }: { items: ListingItemDto[] }) {
  return (
    <ProductGrid columns={4}>
      {items.map((item) => (
        <li key={item.colorwayId}>
          <ProductCard product={item} sizes={CARD_SIZES} wishlistButton={<WishlistCardButton item={item} />} />
        </li>
      ))}
    </ProductGrid>
  );
}

export function HomePage() {
  const home = useHome();

  if (home.isError) {
    return (
      <main className="container">
        <ErrorState error={home.error} action={<Button onClick={() => home.refetch()}>Try again</Button>} />
      </main>
    );
  }

  const data = home.data;

  return (
    <main className={styles.home}>
      <div className="container">
        {data ? (
          <Hero
            slides={data.hero}
            actions={
              <>
                <ButtonLink to="/c/men" size="lg">
                  Shop Men
                </ButtonLink>
                <ButtonLink to="/c/women" size="lg" variant="secondary">
                  Shop Women
                </ButtonLink>
              </>
            }
          />
        ) : (
          <Skeleton height="min(72vh, 640px)" radius="lg" />
        )}
      </div>

      <section className={`container ${styles.tiles}`} aria-label="Shop by collection">
        {data
          ? data.tiles.map((t) => <CollectionTile key={t.to} to={t.to} title={t.title} tone={t.tone} image={t.image} arch={t.arch} />)
          : [0, 1, 2, 3].map((i) => <Skeleton key={i} ratio="4/5" radius="lg" />)}
      </section>

      {data?.editorial.length ? (
        <div className="container section">
          <EditorialSection
            slides={data.editorial.map((e) => ({ ...e, cta: { to: e.to, label: e.cta } }))}
          />
        </div>
      ) : null}

      <section className={`container section ${styles.showcase}`} aria-labelledby="showcase-title">
        <div className={styles.showcaseHead}>
          <h2 id="showcase-title">Shop the collection</h2>
          <ButtonLink to="/search" variant="link">
            View all
          </ButtonLink>
        </div>
        {data ? (
          <Tabs
            label="Product showcase"
            items={[
              { id: 'featured', label: 'Featured', content: <Showcase items={data.showcase.featured} /> },
              { id: 'men', label: 'Men', content: <Showcase items={data.showcase.men} /> },
              { id: 'women', label: 'Women', content: <Showcase items={data.showcase.women} /> },
            ]}
          />
        ) : (
          <ProductGrid columns={4}>
            {[0, 1, 2, 3].map((i) => (
              <li key={i}>
                <ProductCardSkeleton />
              </li>
            ))}
          </ProductGrid>
        )}
      </section>

      <PersonalRows />
      <div className="container section">
        <RecentlyViewedRail title="Pick up where you left off" />
      </div>
    </main>
  );
}
