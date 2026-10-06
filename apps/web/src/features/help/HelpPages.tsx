import { formatINR } from '@avero/shared';
import { Gift, HelpCircle, Mail, PackageSearch, RotateCcw, Sparkles, Truck, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, NavLink, useParams } from 'react-router';
import { ButtonLink } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/Feedback';
import { Accordion, Breadcrumbs } from '../../components/ui/Nav';
import { deliveryPromise } from '../../lib/shipping';
import { usePublicConfig, type PublicConfig } from '../auth/hooks';
import styles from './Help.module.css';

interface Topic {
  slug: string;
  title: string;
  icon: LucideIcon;
  summary: string;
  body: (config: PublicConfig | undefined) => ReactNode;
}

const returnDays = (c?: PublicConfig) => c?.returnWindowDays ?? 15;

const TOPICS: Topic[] = [
  {
    slug: 'shipping',
    title: 'Shipping',
    icon: Truck,
    summary: 'Delivery options, times and tracking',
    body: (c) => (
      <>
        <p>{deliveryPromise(c?.freeShippingThresholdPaise).headline}. We ship from our fulfilment centre in Bengaluru to most PIN codes in India.</p>
        <h2>Delivery options</h2>
        <ul>
          <li>
            <strong>Standard delivery</strong> — 3–6 business days,{' '}
            {c && c.freeShippingThresholdPaise > 0 ? `free over ${formatINR(c.freeShippingThresholdPaise)}, otherwise ${formatINR(9900)}` : 'free'}.
          </li>
          <li>
            <strong>Express delivery</strong> — 1–2 business days, {formatINR(19900)}. Available in major metros (Delhi, Mumbai, Pune, Bengaluru, Chennai, Hyderabad,
            Kolkata, Ahmedabad).
          </li>
        </ul>
        <p>Orders placed before 2 pm IST leave the same day. Our courier doesn’t deliver on Sundays. Enter your PIN code on any product page to see the delivery date.</p>
        <h2>Tracking</h2>
        <p>
          We email you when your order ships, with a tracking number. Members can follow every order in <Link to="/account/orders">My account</Link>; guests can use{' '}
          <Link to="/track">Track your order</Link> with the order number and email.
        </p>
        <h2>Changing or cancelling</h2>
        <p>You can cancel a whole order or individual items until it ships. Refunds go back to your original payment method automatically.</p>
      </>
    ),
  },
  {
    slug: 'returns',
    title: 'Returns & exchanges',
    icon: RotateCcw,
    summary: 'Free pickup after delivery',
    body: (c) => (
      <>
        <p>
          Not quite right? Return or exchange unworn pairs within {returnDays(c)} days of delivery. Start from your order page — we collect from your delivery address for
          free.
        </p>
        <h2>Returns</h2>
        <ul>
          <li>Choose the items and a reason; pickup is booked for the next day.</li>
          <li>Once the pair passes inspection, we refund the amount you paid for it to your original payment method (5–7 business days), or instantly as AVERO points.</li>
          <li>Delivery charges aren’t refunded on returns. Final-sale items can’t be returned.</li>
        </ul>
        <h2>Exchanges</h2>
        <ul>
          <li>Swap for another size or colour of the same product at the same price — free, once per item.</li>
          <li>We set your new pair aside when you ask and send it as soon as the original passes inspection.</li>
          <li>If the size you want is sold out, you can return instead.</li>
        </ul>
        <p>
          Members can follow returns under <Link to="/account/returns">My account → Returns</Link>.
        </p>
      </>
    ),
  },
  {
    slug: 'rewards',
    title: 'AVERO Rewards',
    icon: Gift,
    summary: 'Earn points on every order',
    body: () => (
      <>
        <p>Every AVERO account earns points — 1 point is worth ₹1 at checkout.</p>
        <ul>
          <li>
            <strong>1 point for every ₹100</strong> you pay (excluding delivery). Points become available once the order’s return window closes.
          </li>
          <li>
            <strong>25 points</strong> for your first review of each product.
          </li>
          <li>
            <strong>250 points</strong> when a friend you invite completes their first order — and they get ₹250 off it.
          </li>
          <li>Use points for up to 20% of an order. Points expire 12 months after they become available; points you get back as a refund never expire.</li>
        </ul>
        <div className={styles.actions}>
          <ButtonLink to="/account/rewards">See your points</ButtonLink>
          <ButtonLink to="/account/referrals" variant="secondary">
            Invite friends
          </ButtonLink>
        </div>
      </>
    ),
  },
  {
    slug: 'faq',
    title: 'FAQ',
    icon: HelpCircle,
    summary: 'Sizing, payments, accounts and more',
    body: (c) => (
      <div className={styles.faq}>
        <Accordion title="How do I find my size?" defaultOpen>
          <p>Every product page has a size guide with UK/India, US and EU sizes and foot length. Reviews also show whether a style runs small, true to size or large.</p>
        </Accordion>
        <Accordion title="Do I need an account to order?">
          <p>No — you can check out as a guest with your email and phone. An account lets you save addresses, track every order in one place and earn rewards.</p>
        </Accordion>
        <Accordion title="Which payment methods do you accept?">
          <p>UPI, credit and debit cards, and net banking. Payments on AVERO are simulated for this demo — no real money moves and card details never leave your browser.</p>
        </Accordion>
        <Accordion title="My payment failed. Was I charged?">
          <p>No. If a payment fails or is cancelled, nothing is taken and your items stay reserved for 15 minutes so you can try again.</p>
        </Accordion>
        <Accordion title="Can I change my order after placing it?">
          <p>You can cancel the whole order or individual items until it ships, from your order page. To change a size after delivery, request an exchange.</p>
        </Accordion>
        <Accordion title="How long do refunds take?">
          <p>
            We start the refund as soon as a cancellation goes through or a return passes inspection. Banks usually take 5–7 business days. If a bank refund keeps failing,
            members receive AVERO points instead.
          </p>
        </Accordion>
        <Accordion title="What is your return window?">
          <p>{returnDays(c)} days from delivery, with free pickup. See Returns & exchanges for details.</p>
        </Accordion>
        <Accordion title="An item I want is sold out.">
          <p>Choose your size and tap “Notify me” — we’ll email you when it’s back. You can also ask to be told if a product’s price drops.</p>
        </Accordion>
      </div>
    ),
  },
  {
    slug: 'about',
    title: 'Our story',
    icon: Sparkles,
    summary: 'Modern footwear for everyday movement',
    body: () => (
      <>
        <p>
          AVERO makes modern footwear for everyday movement — shoes designed for comfort from the first step and made to last. We keep our range small and considered:
          a handful of silhouettes, refined season after season.
        </p>
        <p>
          AVERO is a fictional brand built as a demonstration store. Everything works end to end — from checkout to returns — but no real products are sold and no real
          payments are taken.
        </p>
        <div className={styles.actions}>
          <ButtonLink to="/collections/new-arrivals">Shop new arrivals</ButtonLink>
        </div>
      </>
    ),
  },
  {
    slug: 'contact',
    title: 'Contact us',
    icon: Mail,
    summary: 'Get in touch with our team',
    body: () => (
      <>
        <p>Most questions are answered fastest from your order page — you can track, cancel, return or exchange there without waiting for us.</p>
        <dl className={styles.contact}>
          <div>
            <dt>Email</dt>
            <dd>help@avero.example (demo — not monitored)</dd>
          </div>
          <div>
            <dt>Hours</dt>
            <dd>Monday to Saturday, 9 am – 7 pm IST</dd>
          </div>
        </dl>
        <p>When you write, include your order number (it starts with AV-) so we can help quicker.</p>
      </>
    ),
  },
];

function HelpNav() {
  return (
    <nav aria-label="Help topics" className={styles.nav}>
      {TOPICS.map((t) => (
        <NavLink key={t.slug} to={`/help/${t.slug}`} className={({ isActive }) => (isActive ? styles.active : undefined)}>
          <t.icon size={16} aria-hidden /> {t.title}
        </NavLink>
      ))}
      <NavLink to="/track" className={styles.navExtra}>
        <PackageSearch size={16} aria-hidden /> Track your order
      </NavLink>
    </nav>
  );
}

/** /help */
export function HelpIndexPage() {
  return (
    <main className={`container ${styles.page}`}>
      <header className={styles.hero}>
        <p className="eyebrow">Help</p>
        <h1>How can we help?</h1>
        <p className="meta">Answers about delivery, returns, rewards and your account.</p>
      </header>
      <ul role="list" className={styles.cards}>
        {TOPICS.map((t) => (
          <li key={t.slug}>
            <Link to={`/help/${t.slug}`} className={styles.card}>
              <t.icon size={22} strokeWidth={1.5} aria-hidden />
              <span className={styles.cardTitle}>{t.title}</span>
              <span className="meta">{t.summary}</span>
            </Link>
          </li>
        ))}
        <li>
          <Link to="/track" className={styles.card}>
            <PackageSearch size={22} strokeWidth={1.5} aria-hidden />
            <span className={styles.cardTitle}>Track your order</span>
            <span className="meta">With your order number and email</span>
          </Link>
        </li>
      </ul>
    </main>
  );
}

/** /help/:topic */
export function HelpTopicPage() {
  const { topic } = useParams();
  const { data: config } = usePublicConfig();
  const t = TOPICS.find((x) => x.slug === topic);
  if (!t) {
    return (
      <main className="container">
        <EmptyState icon={HelpCircle} title="We couldn’t find that help topic" action={<ButtonLink to="/help">All help topics</ButtonLink>} />
      </main>
    );
  }
  return (
    <main className={`container ${styles.page}`}>
      <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'Help', to: '/help' }, { label: t.title }]} />
      <div className={styles.layout}>
        <aside>
          <HelpNav />
        </aside>
        <article className={styles.article}>
          <h1>{t.title}</h1>
          <div className={styles.prose}>{t.body(config)}</div>
        </article>
      </div>
    </main>
  );
}
