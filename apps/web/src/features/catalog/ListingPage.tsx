import { SORT_LABELS, SORT_OPTIONS, colorFamilyLabel, formatINR, type ListingResponse } from '@avero/shared';
import { SearchX, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { EmptyState, ErrorState, LoadingRegion, ProductCardSkeleton, Skeleton } from '../../components/ui/Feedback';
import { InlineSelect } from '../../components/ui/Form';
import { ProductCard, ProductGrid, ProductMedia } from '../../components/ui/Merch';
import { Breadcrumbs } from '../../components/ui/Nav';
import { Drawer } from '../../components/ui/Overlay';
import { useListing } from '../../lib/catalog';
import { WishlistCardButton } from '../wishlist/WishlistButton';
import { ActiveFilters, FILTER_KEYS, FilterPanel, type ActiveFilter, type FilterUpdate } from './FilterPanel';
import styles from './ListingPage.module.css';

type Mode = 'category' | 'collection' | 'search';

const CARD_SIZES = '(min-width: 1280px) 22vw, (min-width: 768px) 30vw, 50vw';

const ACTIVITY_LABELS: Record<string, string> = { running: 'Running', training: 'Training', sneakers: 'Sneakers', casual: 'Casual', lifestyle: 'Lifestyle' };
const GENDER_LABELS: Record<string, string> = { men: 'Men', women: 'Women', unisex: 'Unisex' };

function activeFilters(params: URLSearchParams): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const multi = (key: string, label: (v: string) => string) => {
    const values = (params.get(key) ?? '').split(',').filter(Boolean);
    for (const v of values) {
      const rest = values.filter((x) => x !== v);
      out.push({ key: `${key}:${v}`, label: label(v), update: { [key]: rest.length ? rest.join(',') : null } });
    }
  };
  multi('gender', (v) => GENDER_LABELS[v] ?? v);
  multi('activity', (v) => ACTIVITY_LABELS[v] ?? v);
  multi('color', colorFamilyLabel);
  multi('size', (v) => `Size ${v}`);
  const min = params.get('priceMin');
  const max = params.get('priceMax');
  if (min || max) {
    const label = min && max ? `${formatINR(+min * 100)}–${formatINR(+max * 100)}` : min ? `Over ${formatINR(+min * 100)}` : `Under ${formatINR(+max! * 100)}`;
    out.push({ key: 'price', label, update: { priceMin: null, priceMax: null } });
  }
  if (params.get('inStock') === 'true') out.push({ key: 'inStock', label: 'In stock', update: { inStock: null } });
  if (params.get('onSale') === 'true') out.push({ key: 'onSale', label: 'On sale', update: { onSale: null } });
  if (params.get('q') && params.get('qraw')) out.push({ key: 'q', label: `“${params.get('q')}”`, update: { q: null } });
  return out;
}

export function ListingPage({ mode }: { mode: Mode }) {
  const routeParams = useParams();
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);

  const scope = mode === 'category' ? routeParams['*']?.replace(/\/+$/, '') : mode === 'collection' ? routeParams.slug : undefined;

  const apiParams = useMemo(() => {
    const p = new URLSearchParams();
    if (mode === 'category' && scope) p.set('category', scope);
    if (mode === 'collection' && scope) p.set('collection', scope);
    for (const key of [...FILTER_KEYS, 'q', 'sort']) {
      const v = params.get(key);
      if (v) p.set(key, v);
    }
    return p;
  }, [params, mode, scope]);

  const listing = useListing(apiParams);
  const first = listing.data?.pages[0];
  const items = listing.data?.pages.flatMap((p) => p.items) ?? [];

  const update = (u: FilterUpdate) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(u)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };
  const clearAll = () => update(Object.fromEntries([...FILTER_KEYS, 'q'].map((k) => [k, null])));
  const chips = activeFilters(params);

  const qraw = params.get('qraw');
  const title = mode === 'search' ? (qraw || params.get('q') ? `Results for “${qraw || params.get('q')}”` : 'All shoes') : (first?.context.title ?? '');
  const hide: ('gender' | 'activity')[] = mode === 'category' && scope ? (scope.includes('/') ? ['gender', 'activity'] : ['gender']) : [];

  if (listing.isError && !first) {
    return (
      <main className="container">
        <ErrorState
          error={listing.error}
          title={(listing.error as { code?: string }).code === 'NOT_FOUND' ? 'We couldn’t find this page' : undefined}
          action={<Button onClick={() => listing.refetch()}>Try again</Button>}
        />
      </main>
    );
  }

  const sortControl = first ? (
    <InlineSelect label="Sort by:" value={first.sort} onChange={(e) => update({ sort: e.target.value === 'featured' ? null : e.target.value })}>
      {SORT_OPTIONS.filter((s) => s !== 'relevance' || params.get('q')).map((s) => (
        <option key={s} value={s}>
          {SORT_LABELS[s]}
        </option>
      ))}
    </InlineSelect>
  ) : null;

  return (
    <main className={`container ${styles.page}`}>
      <header className={styles.head}>
        {first ? <Breadcrumbs items={mode === 'search' ? [{ label: 'Home', to: '/' }, { label: 'Search' }] : first.context.breadcrumbs} /> : <Skeleton width={160} height={14} />}
        <div className={styles.titleRow}>
          <div className={styles.titleBlock}>
            {first || mode === 'search' ? <h1>{title}</h1> : <Skeleton width={280} height={40} />}
            {first ? (
              <p className="meta" aria-live="polite">
                {first.total} {first.total === 1 ? 'product' : 'products'}
              </p>
            ) : null}
            {first?.context.description ? <p className={styles.description}>{first.context.description}</p> : null}
          </div>
          <div className={styles.sortDesktop}>{sortControl}</div>
        </div>
        {first?.context.heroImageUrl ? (
          <ProductMedia
            image={{ url: first.context.heroImageUrl, thumbUrl: null, alt: '' }}
            ratio="5/2"
            radius="xl"
            priority
            sizes="100vw"
            className={styles.banner}
          />
        ) : null}
      </header>

      <div className={styles.mobileBar}>
        <Button variant="secondary" icon={<SlidersHorizontal size={16} aria-hidden />} onClick={() => setFiltersOpen(true)}>
          Filter & sort{chips.length ? ` (${chips.length})` : ''}
        </Button>
      </div>

      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label="Filters">
          {first ? <FilterPanel facets={first.facets} params={params} onChange={update} hide={hide} /> : <FilterSkeleton />}
        </aside>

        <section className={styles.results} aria-label="Products" aria-busy={listing.isFetching}>
          <ActiveFilters filters={chips} onChange={update} onClear={clearAll} />

          {!first ? (
            <LoadingRegion label="Loading products">
              <ProductGrid>
                {Array.from({ length: 6 }, (_, i) => (
                  <li key={i}>
                    <ProductCardSkeleton />
                  </li>
                ))}
              </ProductGrid>
            </LoadingRegion>
          ) : items.length === 0 ? (
            <NoResults response={first} mode={mode} hasFilters={chips.length > 0} onClear={clearAll} />
          ) : (
            <div className={listing.isPlaceholderData ? styles.stale : undefined}>
              <ProductGrid>
                {items.map((item, i) => (
                  <li key={item.colorwayId}>
                    <ProductCard product={item} priority={i < 3} sizes={CARD_SIZES} wishlistButton={<WishlistCardButton item={item} />} />
                  </li>
                ))}
              </ProductGrid>
              <div className={styles.more}>
                <p className="meta">
                  Showing {items.length} of {first.total}
                </p>
                {listing.hasNextPage ? (
                  <Button variant="secondary" onClick={() => listing.fetchNextPage()} loading={listing.isFetchingNextPage}>
                    Load more
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </section>
      </div>

      <Drawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filter & sort"
        footer={
          <div className={styles.drawerFoot}>
            {chips.length ? (
              <Button variant="ghost" onClick={clearAll}>
                Clear all
              </Button>
            ) : null}
            <Button fullWidth onClick={() => setFiltersOpen(false)} loading={listing.isFetching}>
              Show {first?.total ?? ''} results
            </Button>
          </div>
        }
      >
        <div className={styles.drawerSort}>{sortControl}</div>
        {first ? <FilterPanel facets={first.facets} params={params} onChange={update} hide={hide} /> : null}
      </Drawer>
    </main>
  );
}

function NoResults({ response, mode, hasFilters, onClear }: { response: ListingResponse; mode: Mode; hasFilters: boolean; onClear: () => void }) {
  const [params, setParams] = useSearchParams();
  const apply = (p: Record<string, string>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(p)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  const qraw = params.get('qraw');
  return (
    <EmptyState
      icon={SearchX}
      title={mode === 'search' && qraw ? `No exact matches for “${qraw}”` : 'No products match these filters'}
      body={
        response.relaxations.length ? (
          <>
            You could try:
            <span className={styles.relaxations}>
              {response.relaxations.map((r) => (
                <button key={r.label} type="button" className={styles.relaxation} onClick={() => apply(r.params)}>
                  {r.label} <span className="meta">({r.count})</span>
                </button>
              ))}
            </span>
          </>
        ) : (
          'Try removing a filter, or search for something else.'
        )
      }
      action={
        hasFilters ? (
          <Button variant="secondary" onClick={onClear}>
            Clear all filters
          </Button>
        ) : (
          <ButtonLink to="/collections/new-arrivals">Browse new arrivals</ButtonLink>
        )
      }
    />
  );
}

function FilterSkeleton() {
  return (
    <div className={styles.filterSkeleton} aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i}>
          <Skeleton width="40%" height={16} />
          <Skeleton height={36} />
        </div>
      ))}
    </div>
  );
}
