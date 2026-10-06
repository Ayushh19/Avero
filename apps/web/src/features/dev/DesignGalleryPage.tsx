import { formatINR } from '@avero/shared';
import { Heart, Package, RefreshCcw, ShieldCheck, ShoppingBag, Truck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, ButtonLink, IconButton } from '../../components/ui/Button';
import {
  Badge,
  PriceTag,
  QuantityStepper,
  Rating,
  SizeSelector,
  StarInput,
  StockIndicator,
  SwatchGroup,
  type SizeOption,
  type SwatchOption,
} from '../../components/ui/Commerce';
import { EmptyState, ErrorState, ProductCardSkeleton, Skeleton } from '../../components/ui/Feedback';
import { Checkbox, Field, FormError, InlineSelect, RadioCard, SelectField } from '../../components/ui/Form';
import { ProductCard, ProductGrid, ProductMedia, TrustRow, WishButton, type ProductCardData } from '../../components/ui/Merch';
import { Accordion, Breadcrumbs, OrderTimeline, Stepper, Tabs } from '../../components/ui/Nav';
import { Dialog, Drawer, useToast } from '../../components/ui/Overlay';
import { ApiError } from '../../lib/api';
import styles from './DesignGalleryPage.module.css';

// Sample data for visual review only — never used outside this dev page.
const COLORS: SwatchOption[] = [
  { id: 'grey', name: 'Blizzard Grey', hex: '#B9BBB8' },
  { id: 'navy', name: 'Deep Navy', hex: '#26324A' },
  { id: 'black', name: 'Black', hex: '#1E1E1E' },
  { id: 'sand', name: 'Sand', hex: '#C9B8A3' },
  { id: 'olive', name: 'Olive', hex: '#6E7356', available: false },
];

const SIZES: SizeOption[] = ['6', '7', '8', '9', '10', '11', '12'].map((s, i) => ({
  id: s,
  label: s,
  state: i === 5 ? 'unavailable' : i === 4 ? 'low' : 'available',
}));

const SW = COLORS.map((c) => ({ colorwayId: c.id, name: c.name, hex: c.hex, href: '#' }));
const SAMPLE_PRODUCTS: ProductCardData[] = [
  { href: '#', name: "Men's Strider", colorName: 'Blizzard / Dark Navy', image: null, pricePaise: 599900, badge: 'Bestseller', swatches: SW, rating: { value: 4.6, count: 320 } },
  { href: '#', name: "Men's Cruiser Remix", colorName: 'Natural White', image: null, pricePaise: 699900, mrpPaise: 799900, badge: 'New', swatches: SW.slice(0, 3) },
  { href: '#', name: "Women's Tree Dasher", colorName: 'Thunder Green', image: null, pricePaise: 649900, swatches: SW.slice(1, 4), rating: { value: 4.2, count: 48 } },
  { href: '#', name: "Men's Wool Runner", colorName: 'Dark Grey', image: null, pricePaise: 549900, inStock: false },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

export function DesignGalleryPage() {
  const toast = useToast();
  const [color, setColor] = useState('navy');
  const [size, setSize] = useState('9');
  const [qty, setQty] = useState(1);
  const [stars, setStars] = useState(4);
  const [wish, setWish] = useState<Record<number, boolean>>({});
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);

  return (
    <main className={`container ${styles.page}`}>
      <header className={styles.intro}>
        <p className="eyebrow">Dev only</p>
        <h1>AVERO design system</h1>
        <p className="meta">Live components from docs/DESIGN.md. Sample data on this page is for visual review only.</p>
      </header>

      <Section title="Colour">
        <ul role="list" className={styles.palette}>
          {['bg', 'surface', 'surface-muted', 'sand', 'sage', 'mist', 'mauve', 'ink', 'ink-2', 'ink-3', 'border', 'success', 'warning', 'danger'].map((t) => (
            <li key={t}>
              <span style={{ background: `var(--color-${t})` }} />
              <code>--color-{t}</code>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Typography">
        <div className={styles.type}>
          <p className="eyebrow">Eyebrow · new collection</p>
          <p className={styles.hero}>Modern comfort for your active life</p>
          <h1>Page title — Men's Shoes</h1>
          <h2>Section heading — You may also like</h2>
          <p style={{ fontWeight: 600 }}>Product name — Men's Strider</p>
          <p className="meta">Metadata — Blizzard / Dark Navy · 120 products</p>
          <PriceTag price={599900} mrp={699900} />
          <p>Body — The Strider combines lightweight comfort with a clean, modern design built for everyday wear.</p>
        </div>
      </Section>

      <Section title="Buttons">
        <div className={styles.row}>
          <Button>Add to bag</Button>
          <Button variant="secondary">Shop Women</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Size guide</Button>
          <Button loading>Paying</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <IconButton label="Add to wishlist" shape="square" bordered>
            <Heart size={20} aria-hidden />
          </IconButton>
          <ButtonLink to="/" variant="secondary">
            Link button
          </ButtonLink>
        </div>
      </Section>

      <Section title="Form controls">
        <div className={styles.formGrid}>
          <Field label="Email" name="demo-email" placeholder="you@example.com" />
          <Field label="PIN code" name="demo-pin" error="We don't deliver to this PIN code yet" defaultValue="999999" />
          <SelectField label="State" name="demo-state" defaultValue="MH">
            <option value="MH">Maharashtra</option>
            <option value="KA">Karnataka</option>
          </SelectField>
          <Field label="Coupon" name="demo-coupon" hint="One coupon per order" />
          <div className={styles.stackSm}>
            <Checkbox label="Sneakers" defaultChecked />
            <Checkbox label="Running" />
          </div>
          <InlineSelect label="Sort by:" defaultValue="featured">
            <option value="featured">Featured</option>
            <option value="new">Newest</option>
            <option value="price-asc">Price: low to high</option>
          </InlineSelect>
          <FormError message="Your session expired. Please sign in again to continue." />
        </div>
        <div className={styles.radioStack}>
          <RadioCard
            name="demo-address"
            defaultChecked
            title="Home"
            description={'Riya Sharma\n12, Palm Beach Road, Navi Mumbai\nMaharashtra 400706'}
            action={<Button variant="link" size="sm">Edit</Button>}
          />
          <RadioCard name="demo-ship" title="Standard delivery" description="3–6 business days" aside="Free" defaultChecked />
          <RadioCard name="demo-ship" title="Express delivery" description="1–2 business days" aside={formatINR(19900)} />
        </div>
      </Section>

      <Section title="Selection">
        <div className={styles.selection}>
          <div className={styles.stackSm}>
            <p className="meta">
              Colour: <strong>{COLORS.find((c) => c.id === color)?.name}</strong>
            </p>
            <SwatchGroup label="Colour" options={COLORS} value={color} onChange={setColor} />
          </div>
          <div className={styles.stackSm}>
            <p className="meta">
              Size: <strong>UK {size}</strong>
            </p>
            <SizeSelector label="Size" options={SIZES} value={size} onChange={setSize} />
          </div>
          <div className={styles.row}>
            <QuantityStepper value={qty} max={5} onChange={setQty} />
            <Rating value={4.6} count={320} size="md" />
          </div>
          <div className={styles.row}>
            <StarInput value={stars} onChange={setStars} />
            <Badge>New</Badge>
            <Badge tone="success">Delivered</Badge>
            <Badge tone="warning">Pending</Badge>
            <Badge tone="danger">Sold out</Badge>
          </div>
          <StockIndicator state="in" note="Ships in 2–3 days" />
          <StockIndicator state="low" left={2} />
          <StockIndicator state="out" />
        </div>
      </Section>

      <Section title="Product cards">
        <ProductGrid columns={4}>
          {SAMPLE_PRODUCTS.map((p, i) => (
            <li key={p.name}>
              <ProductCard
                product={p}
                wishlistButton={<WishButton name={p.name} pressed={Boolean(wish[i])} onClick={() => setWish((w) => ({ ...w, [i]: !w[i] }))} />}
              />
            </li>
          ))}
        </ProductGrid>
        <ProductGrid columns={4}>
          {[0, 1, 2, 3].map((i) => (
            <li key={i}>
              <ProductCardSkeleton />
            </li>
          ))}
        </ProductGrid>
      </Section>

      <Section title="Media & trust">
        <div className={styles.mediaRow}>
          <ProductMedia alt="Placeholder" ratio="4/5" tone="sage" />
          <ProductMedia alt="Placeholder" ratio="4/5" tone="mist" radius="arch" />
          <ProductMedia alt="Placeholder" ratio="4/5" tone="mauve" />
        </div>
        <TrustRow
          items={[
            { icon: Truck, title: 'Free delivery', body: 'On every order, no minimum' },
            { icon: RefreshCcw, title: 'Easy returns', body: 'Within 15 days of delivery' },
            { icon: ShieldCheck, title: 'Secure checkout', body: 'Simulated payments only' },
          ]}
        />
      </Section>

      <Section title="Navigation">
        <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'Men', to: '/c/men' }, { label: "Men's Strider" }]} />
        <Tabs
          label="Product information"
          items={[
            { id: 'desc', label: 'Description', content: <p>Lightweight comfort with a clean, modern design.</p> },
            { id: 'details', label: 'Details', content: <p>Breathable knit upper · Cushioned midsole · Durable rubber outsole</p> },
            { id: 'reviews', label: 'Reviews', content: <Rating value={4.6} count={320} size="md" /> },
            { id: 'ship', label: 'Shipping & Returns', content: <p>Free delivery on all orders. Returns within 15 days.</p> },
          ]}
        />
        <div>
          <Accordion title="Category" defaultOpen meta="2 selected">
            <div className={styles.stackSm}>
              <Checkbox label="Sneakers" defaultChecked />
              <Checkbox label="Running" defaultChecked />
              <Checkbox label="Casual" />
            </div>
          </Accordion>
          <Accordion title="Size">
            <SizeSelector label="Filter by size" options={SIZES} onChange={() => undefined} />
          </Accordion>
        </div>
        <Stepper steps={['Bag', 'Address', 'Payment', 'Review']} current={2} />
        <OrderTimeline
          steps={[
            { label: 'Order placed', at: '24 Oct, 10:12', state: 'done' },
            { label: 'Confirmed', at: '24 Oct, 10:13', state: 'done' },
            { label: 'Packed', at: '25 Oct, 09:40', state: 'done' },
            { label: 'Shipped', at: '25 Oct, 18:05', state: 'done' },
            { label: 'Out for delivery', at: '27 Oct, 08:30', state: 'current' },
            { label: 'Delivered', state: 'upcoming' },
          ]}
        />
      </Section>

      <Section title="Overlays & feedback">
        <div className={styles.row}>
          <Button variant="secondary" onClick={() => setDialog(true)}>
            Open dialog
          </Button>
          <Button variant="secondary" onClick={() => setDrawer(true)}>
            Open drawer
          </Button>
          <Button variant="secondary" onClick={() => toast.success("Added to bag — Men's Strider, UK 9")}>
            Success toast
          </Button>
          <Button variant="secondary" onClick={() => toast.error('That size just sold out.')}>
            Error toast
          </Button>
          <Button
            variant="secondary"
            onClick={() => toast.show('Removed from wishlist', { action: { label: 'Undo', onClick: () => toast.success('Restored') } })}
          >
            Toast with action
          </Button>
        </div>
        <div className={styles.states}>
          <div className={styles.panel}>
            <EmptyState icon={ShoppingBag} title="Your bag is empty" body="Find something you love — it'll wait for you here." action={<ButtonLink to="/">Start shopping</ButtonLink>} />
          </div>
          <div className={styles.panel}>
            <ErrorState
              error={new ApiError(500, 'INTERNAL', 'We couldn’t load your orders right now.', undefined, '7f3a9c21-0000')}
              action={<Button variant="secondary">Try again</Button>}
            />
          </div>
          <div className={styles.panel}>
            <EmptyState icon={Package} compact title="No orders yet" body="When you place an order, you'll be able to track it here." />
            <Skeleton height={14} width="60%" />
          </div>
        </div>
      </Section>

      <Dialog open={dialog} onClose={() => setDialog(false)} title="Size guide" footer={<Button fullWidth onClick={() => setDialog(false)}>Done</Button>}>
        <p className="meta">Measure your foot from heel to longest toe. Between sizes? Size up.</p>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>UK/IND</th>
              <th>US</th>
              <th>EU</th>
              <th>cm</th>
            </tr>
          </thead>
          <tbody>
            {[['7', '8', '41', '25.4'], ['8', '9', '42', '26.2'], ['9', '10', '43', '27.1']].map((r) => (
              <tr key={r[0]}>
                {r.map((c) => (
                  <td key={c}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Dialog>
      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="Your bag (1)"
        footer={
          <div className={styles.stackSm}>
            <div className={styles.between}>
              <span>Subtotal</span>
              <strong>{formatINR(599900)}</strong>
            </div>
            <Button fullWidth size="lg">
              Proceed to checkout
            </Button>
          </div>
        }
      >
        <div className={styles.bagLine}>
          <ProductMedia alt="Men's Strider" tone="muted" radius="md" />
          <div className={styles.stackSm}>
            <strong>Men's Strider</strong>
            <span className="meta">Blizzard / Dark Navy · UK 9</span>
            <QuantityStepper value={qty} max={5} onChange={setQty} />
          </div>
          <PriceTag price={599900} />
        </div>
      </Drawer>
    </main>
  );
}
