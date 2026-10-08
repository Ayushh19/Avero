import { formatINR, type ColorwayDto, type ListingItemDto, type ProductDetailDto, type SkuDto } from '@avero/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bell, BellRing, MapPin, RefreshCcw, ShieldCheck, Truck } from 'lucide-react';
import { lazy, Suspense, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { PriceTag, Rating, SizeSelector, StockIndicator, type SizeOption } from '../../components/ui/Commerce';
import { ErrorState, LoadingRegion, Skeleton } from '../../components/ui/Feedback';
import { Field, FormError } from '../../components/ui/Form';
import { ProductCard, ProductRail, TrustRow } from '../../components/ui/Merch';
import { Breadcrumbs, Tabs } from '../../components/ui/Nav';
import { Dialog, useToast } from '../../components/ui/Overlay';
import { ApiError, api, errorMessage } from '../../lib/api';
import { useDeliveryEstimate, useProduct, useRecommendations } from '../../lib/catalog';
import { cx } from '../../lib/cx';
import { deliveryPromise } from '../../lib/shipping';
import { savedPincode } from '../../lib/storage';
import { useMe, usePublicConfig } from '../auth/hooks';
import { useAddToBag } from '../bag/hooks';
import { buyNowHref } from '../checkout/hooks';
import { RecentlyViewedRail, useRecordView } from '../recent/recentlyViewed';
import { WishlistCardButton, WishlistIconButton } from '../wishlist/WishlistButton';
import { Gallery } from './Gallery';

// Reviews sit in a tab below the fold; their code (and the forms it uses) loads after first paint.
const ProductReviews = lazy(() => import('../reviews/ProductReviews').then((m) => ({ default: m.ProductReviews })));
import styles from './ProductPage.module.css';

const ACTIVITY: Record<string, string> = { running: 'Running', training: 'Training', sneakers: 'Sneakers', casual: 'Casual', lifestyle: 'Lifestyle' };
const GENDER: Record<string, string> = { men: 'Men', women: 'Women', unisex: 'Unisex' };

export function ProductPage() {
  const { productSlug = '', colorSlug } = useParams();
  const product = useProduct(productSlug);

  if (product.isPending) return <ProductSkeleton />;
  if (product.isError) {
    const notFound = product.error instanceof ApiError && product.error.code === 'NOT_FOUND';
    return (
      <main className="container">
        <ErrorState
          error={product.error}
          title={notFound ? 'This product isn’t available' : undefined}
          action={notFound ? <ButtonLink to="/collections/new-arrivals">Browse new arrivals</ButtonLink> : <Button onClick={() => product.refetch()}>Try again</Button>}
        />
      </main>
    );
  }

  const p = product.data;
  const colorway = p.colorways.find((c) => c.slug === colorSlug);
  // Unknown or missing colour → canonical URL of the first colour.
  if (!colorway) return <Navigate to={p.colorways[0]!.href} replace />;
  return <ProductView key={colorway.id} product={p} colorway={colorway} />;
}

function ProductView({ product: p, colorway }: { product: ProductDetailDto; colorway: ColorwayDto }) {
  const [params, setParams] = useSearchParams();
  const { data: user } = useMe();
  const { data: config } = usePublicConfig();
  const navigate = useNavigate();
  const addToBag = useAddToBag();
  const toast = useToast();
  const sizeGroupRef = useRef<HTMLDivElement>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [sizeGuide, setSizeGuide] = useState(false);
  const [tab, setTab] = useState('description');

  // Selected size lives in the URL (?size=9) so refresh/back/share keep it.
  const preferred = user?.preferredSize && colorway.skus.find((s) => s.sizeLabel === user.preferredSize && s.state !== 'unavailable');
  const selected: SkuDto | undefined = colorway.skus.find((s) => s.sizeLabel === params.get('size')) ?? (preferred || undefined);
  const purchasable = colorway.purchasable && p.status === 'active';
  const allSoldOut = colorway.skus.every((s) => s.state === 'unavailable');

  const price = selected?.pricePaise ?? Math.min(...colorway.skus.map((s) => s.pricePaise));
  const mrp = selected?.mrpPaise ?? colorway.skus.find((s) => s.pricePaise === price)?.mrpPaise ?? price;

  useRecordView({
    colorwayId: colorway.id,
    href: colorway.href,
    name: p.name,
    colorName: colorway.name,
    pricePaise: price,
    image: colorway.images[0] ?? null,
  });

  const sizeOptions: SizeOption[] = colorway.skus.map((s) => ({ id: s.id, label: s.sizeLabel, state: s.state }));

  const selectSize = (skuId: string) => {
    const sku = colorway.skus.find((s) => s.id === skuId);
    setSizeError(null);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (sku) next.set('size', sku.sizeLabel);
      return next;
    }, { replace: true, preventScrollReset: true });
  };

  const requireSize = (): SkuDto | null => {
    if (!selected) {
      setSizeError('Please select a size');
      sizeGroupRef.current?.querySelector('button')?.focus();
      return null;
    }
    return selected;
  };

  const add = () => {
    const sku = requireSize();
    if (!sku || sku.state === 'unavailable') return;
    addToBag.mutate(
      { skuId: sku.id },
      {
        onError: (err) => {
          setSizeError(errorMessage(err));
          toast.error(errorMessage(err));
        },
      },
    );
  };

  // Checks out this item alone: the bag (and its drawer) are left untouched.
  const buyNow = () => {
    const sku = requireSize();
    if (!sku || sku.state === 'unavailable') return;
    navigate(buyNowHref(sku.id));
  };

  const stock =
    !purchasable ? null
    : selected ? (
      <StockIndicator
        state={selected.state === 'unavailable' ? 'out' : selected.state === 'low' ? 'low' : 'in'}
        left={selected.left ?? undefined}
        note={selected.state !== 'unavailable' ? 'Ships in 1–2 days' : undefined}
      />
    ) : allSoldOut ? (
      <StockIndicator state="out" />
    ) : null;

  return (
    <main className={`container ${styles.page}`}>
      <Breadcrumbs
        items={[
          { label: 'Home', to: '/' },
          ...(p.category.parent ? [{ label: p.category.parent.name, to: `/c/${p.category.parent.path}` }] : []),
          { label: p.category.name, to: `/c/${p.category.path}` },
          { label: p.name },
        ]}
      />

      <div className={styles.layout}>
        <Gallery images={colorway.images} name={p.name} badge={p.badge} />

        <section className={styles.info} aria-label="Product details">
          <div className={styles.titleRow}>
            <div className={styles.titleBlock}>
              <p className="eyebrow">{p.category.name}</p>
              <h1 className={styles.name}>{p.name}</h1>
            </div>
          </div>
          <PriceTag price={price} mrp={mrp} size="lg" />
          <p className="meta">Inclusive of all taxes</p>
          {p.rating.count > 0 ? (
            <a href="#reviews" className={styles.ratingLink} onClick={() => setTab('reviews')}>
              <Rating value={p.rating.value} count={p.rating.count} size="md" />
            </a>
          ) : null}
          {p.shortDescription ? <p className={styles.short}>{p.shortDescription}</p> : null}

          {!purchasable ? (
            <p className={styles.unavailable} role="status">
              This product is no longer available. Take a look at similar styles below.
            </p>
          ) : null}

          <div className={styles.block}>
            <p className={styles.label}>
              Colour: <span>{colorway.name}</span>
            </p>
            <ul className={styles.swatches} role="list" aria-label="Colours">
              {p.colorways.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`${c.href}${selected ? `?size=${encodeURIComponent(selected.sizeLabel)}` : ''}`}
                    replace
                    className={cx(styles.swatch, c.id === colorway.id && styles.swatchOn)}
                    style={{ background: c.hex }}
                    aria-label={`${c.name}${c.id === colorway.id ? ' (selected)' : ''}`}
                    aria-current={c.id === colorway.id}
                    title={c.name}
                  />
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.block}>
            <div className={styles.sizeHead}>
              <p className={styles.label} id="size-label">
                Size (UK/IND){selected ? <span>: {selected.sizeLabel}</span> : null}
              </p>
              {p.sizeChart ? (
                <button type="button" className={styles.sizeGuide} onClick={() => setSizeGuide(true)}>
                  Size guide
                </button>
              ) : null}
            </div>
            <div ref={sizeGroupRef} aria-describedby={sizeError ? 'size-error' : undefined}>
              <SizeSelector label="Size" options={sizeOptions} value={selected?.id} onChange={selectSize} />
            </div>
            {sizeError ? (
              <p id="size-error" className={styles.sizeError} role="alert">
                {sizeError}
              </p>
            ) : null}
            {stock}
          </div>

          {purchasable && selected?.state === 'unavailable' ? (
            <NotifyMe sku={selected} defaultEmail={user?.email} />
          ) : (
            <div className={styles.actions}>
              <Button size="lg" fullWidth onClick={add} loading={addToBag.isPending} disabled={!purchasable || allSoldOut}>
                {allSoldOut ? 'Sold out' : 'Add to bag'}
              </Button>
              <WishlistIconButton item={{ colorwayId: colorway.id, name: p.name, pricePaise: price }} />
              <Button
                variant="secondary"
                size="lg"
                fullWidth
                className={styles.buyNow}
                disabled={!purchasable || allSoldOut}
                onClick={buyNow}
              >
                Buy now
              </Button>
            </div>
          )}

          {purchasable ? <PriceDropAlert colorwayId={colorway.id} price={price} defaultEmail={user?.email} /> : null}

          <DeliveryCheck />

          <TrustRow
            items={[
              { icon: Truck, ...deliveryPromise(config?.freeShippingThresholdPaise) },
              { icon: RefreshCcw, title: 'Easy returns', body: `Within ${config?.returnWindowDays ?? 15} days of delivery` },
              { icon: ShieldCheck, title: 'Secure checkout', body: 'Simulated payments only' },
            ]}
          />
        </section>
      </div>

      <section className={styles.details} id="reviews">
        <Tabs
          label="Product information"
          activeId={tab}
          onChange={setTab}
          items={[
            {
              id: 'description',
              label: 'Description',
              content: (
                <div className={styles.prose}>
                  <p>{p.description}</p>
                  {p.highlights.length ? (
                    <ul>
                      {p.highlights.map((h) => (
                        <li key={h}>{h}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ),
            },
            {
              id: 'details',
              label: 'Details',
              content: (
                <dl className={styles.specs}>
                  <div>
                    <dt>Gender</dt>
                    <dd>{GENDER[p.gender] ?? p.gender}</dd>
                  </div>
                  <div>
                    <dt>Category</dt>
                    <dd>{ACTIVITY[p.activity] ?? p.category.name}</dd>
                  </div>
                  <div>
                    <dt>Colour</dt>
                    <dd>{colorway.name}</dd>
                  </div>
                  <div>
                    <dt>Sizes</dt>
                    <dd>UK/IND {colorway.skus.map((s) => s.sizeLabel).join(', ')}</dd>
                  </div>
                  <div>
                    <dt>GST</dt>
                    <dd>{p.gstRateBps / 100}% (included in price)</dd>
                  </div>
                </dl>
              ),
            },
            {
              id: 'reviews',
              label: `Reviews${p.rating.count ? ` (${p.rating.count})` : ''}`,
              content: (
                <Suspense fallback={<Skeleton height={240} />}>
                  <ProductReviews slug={p.slug} />
                </Suspense>
              ),
            },
            {
              id: 'shipping',
              label: 'Shipping & Returns',
              content: (
                <div className={styles.prose}>
                  <p>
                    {config && config.freeShippingThresholdPaise > 0
                      ? `Free standard shipping on orders over ${formatINR(config.freeShippingThresholdPaise)}; otherwise ${formatINR(9900)}.`
                      : 'Free standard delivery on every order (3–6 business days).'}{' '}
                    Express delivery (1–2 business days, {formatINR(19900)}) is available in major metros.
                  </p>
                  <p>
                    {p.isFinalSale
                      ? 'This item is final sale and cannot be returned.'
                      : `Return or exchange unworn pairs within ${config?.returnWindowDays ?? 15} days of delivery. Free pickup from your address; refunds go back to your original payment method or as AVERO points.`}
                  </p>
                </div>
              ),
            },
          ]}
        />
      </section>

      <FrequentlyBoughtTogether slug={p.slug} />
      <Recommendations slug={p.slug} />
      <RecentlyViewedRail exclude={colorway.id} />

      {p.sizeChart ? (
        <Dialog open={sizeGuide} onClose={() => setSizeGuide(false)} title={`Size guide — ${p.sizeChart.name}`} footer={<Button fullWidth onClick={() => setSizeGuide(false)}>Done</Button>}>
          {p.sizeChart.guidance ? <p className="meta">{p.sizeChart.guidance}</p> : null}
          <table className={styles.chart}>
            <thead>
              <tr>
                <th scope="col">UK/IND</th>
                <th scope="col">US</th>
                <th scope="col">EU</th>
                <th scope="col">Foot length (cm)</th>
              </tr>
            </thead>
            <tbody>
              {p.sizeChart.rows.map((r) => (
                <tr key={r.ukInd} className={cx(selected?.sizeLabel === r.ukInd && styles.chartOn)}>
                  <th scope="row">{r.ukInd}</th>
                  <td>{r.us}</td>
                  <td>{r.eu}</td>
                  <td>{r.cm}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Dialog>
      ) : null}
    </main>
  );
}


function NotifyMe({ sku, defaultEmail }: { sku: SkuDto; defaultEmail?: string }) {
  const toast = useToast();
  const [email, setEmail] = useState(defaultEmail ?? '');
  const notify = useMutation({
    mutationFn: () => api.post<{ email: string }>('/alerts/stock', { skuId: sku.id, ...(defaultEmail ? {} : { email }) }),
    onSuccess: (r) => toast.success(`We’ll email ${r.email} when size ${sku.sizeLabel} is back`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    notify.mutate();
  };
  if (notify.isSuccess) {
    return (
      <p className={styles.notifyDone} role="status">
        <Bell size={16} aria-hidden /> You’re on the list for size {sku.sizeLabel}.
      </p>
    );
  }
  return (
    <form className={styles.notify} onSubmit={submit}>
      <p className={styles.label}>Size {sku.sizeLabel} is sold out. Get an email when it’s back.</p>
      {!defaultEmail ? <Field label="Email" name="notify-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /> : null}
      <FormError message={notify.error ? errorMessage(notify.error) : null} />
      <Button type="submit" variant="secondary" size="lg" fullWidth icon={<Bell size={16} aria-hidden />} loading={notify.isPending}>
        Notify me
      </Button>
    </form>
  );
}

function DeliveryCheck() {
  const stored = savedPincode.useValue();
  const [input, setInput] = useState(stored ?? '');
  const [pincode, setPincode] = useState<string | null>(stored);
  const estimate = useDeliveryEstimate(pincode);
  const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const pin = input.trim();
    setPincode(pin);
    if (/^[1-9]\d{5}$/.test(pin)) savedPincode.set(pin);
  };

  return (
    <div className={styles.delivery}>
      <form className={styles.deliveryForm} onSubmit={submit}>
        <MapPin size={18} aria-hidden />
        <label htmlFor="pdp-pincode" className="visually-hidden">
          Delivery PIN code
        </label>
        <input
          id="pdp-pincode"
          inputMode="numeric"
          maxLength={6}
          placeholder="Enter PIN code for delivery date"
          value={input}
          onChange={(e) => setInput(e.target.value.replace(/\D/g, ''))}
        />
        <button type="submit">Check</button>
      </form>
      {pincode && !/^[1-9]\d{5}$/.test(pincode) ? <p className={styles.deliveryError}>Enter a valid 6-digit PIN code.</p> : null}
      {estimate.isFetching && !estimate.data ? <Skeleton height={14} width="60%" /> : null}
      {estimate.data ? (
        estimate.data.serviceable ? (
          <ul role="list" className={styles.deliveryOptions} aria-live="polite">
            {estimate.data.options.map((o) => (
              <li key={o.method}>
                <strong>{o.label}</strong>: {o.earliest === o.latest ? fmt(o.earliest) : `${fmt(o.earliest)} – ${fmt(o.latest)}`}
              </li>
            ))}
            <li className="meta">{estimate.data.message}</li>
          </ul>
        ) : (
          <p className={styles.deliveryError} role="status">
            {estimate.data.message}
          </p>
        )
      ) : null}
    </div>
  );
}

function FrequentlyBoughtTogether({ slug }: { slug: string }) {
  const fbt = useQuery({
    queryKey: ['catalog', 'fbt', slug],
    queryFn: ({ signal }) => api.get<{ items: ListingItemDto[] }>(`/products/${encodeURIComponent(slug)}/frequently-bought-together`, signal),
    select: (d) => d.items,
    staleTime: 5 * 60_000,
  });
  if (!fbt.data?.length) return null;
  return (
    <ProductRail title="Frequently bought together">
      {fbt.data.map((item) => (
        <li key={item.colorwayId}>
          <ProductCard product={item} sizes="(min-width: 1024px) 22vw, 60vw" wishlistButton={<WishlistCardButton item={item} />} />
        </li>
      ))}
    </ProductRail>
  );
}

/** "Tell me if the price drops": one tap for members, email for guests. */
function PriceDropAlert({ colorwayId, price, defaultEmail }: { colorwayId: string; price: number; defaultEmail?: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const alert = useMutation({
    mutationFn: () => api.post<{ email: string }>('/alerts/price', { colorwayId, ...(defaultEmail ? {} : { email }) }),
    onSuccess: (r) => toast.success(`We’ll email ${r.email} if it drops below ${formatINR(price)}`),
  });
  if (alert.isSuccess) {
    return (
      <p className={styles.priceAlertDone} role="status">
        <BellRing size={15} aria-hidden /> We’ll tell you if the price drops below {formatINR(price)}.
      </p>
    );
  }
  if (!defaultEmail && open) {
    return (
      <form
        className={styles.priceAlertForm}
        onSubmit={(e) => {
          e.preventDefault();
          alert.mutate();
        }}
      >
        <Field label="Email for price-drop alerts" name="price-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        <Button type="submit" variant="secondary" loading={alert.isPending}>
          Notify me
        </Button>
        <FormError message={alert.error ? errorMessage(alert.error) : null} />
      </form>
    );
  }
  return (
    <button type="button" className={styles.priceAlert} onClick={() => (defaultEmail ? alert.mutate() : setOpen(true))} disabled={alert.isPending}>
      <Bell size={15} aria-hidden /> Tell me if the price drops
    </button>
  );
}

function Recommendations({ slug }: { slug: string }) {
  const recs = useRecommendations(slug);
  if (!recs.data?.length) return null;
  return (
    <ProductRail title="You may also like">
      {recs.data.map((item) => (
        <li key={item.colorwayId}>
          <ProductCard product={item} sizes="(min-width: 1024px) 22vw, 60vw" wishlistButton={<WishlistCardButton item={item} />} />
        </li>
      ))}
    </ProductRail>
  );
}

function ProductSkeleton() {
  return (
    <main className={`container ${styles.page}`}>
      <LoadingRegion label="Loading product">
        <Skeleton width={240} height={14} />
        <div className={styles.layout}>
          <Skeleton ratio="1/1" radius="lg" />
          <div className={styles.info}>
            <Skeleton width="70%" height={36} />
            <Skeleton width="30%" height={24} />
            <Skeleton height={60} />
            <Skeleton height={120} />
            <Skeleton height={52} />
          </div>
        </div>
      </LoadingRegion>
    </main>
  );
}
