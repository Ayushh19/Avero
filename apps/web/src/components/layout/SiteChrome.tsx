import { Heart, Menu, Search, ShoppingBag, User } from 'lucide-react';
import { useCart } from '../../features/bag/hooks';
import { SearchBox } from '../../features/search/SearchBox';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { usePublicConfig, useMe } from '../../features/auth/hooks';
import { deliveryPromise } from '../../lib/shipping';
import { NotificationBell } from '../../features/notifications/Notifications';
import { Drawer } from '../ui/Overlay';
import styles from './SiteChrome.module.css';

export const PRIMARY_NAV = [
  { to: '/c/men', label: 'Men' },
  { to: '/c/women', label: 'Women' },
  { to: '/collections/new-arrivals', label: 'New Arrivals' },
  { to: '/collections', label: 'Collections' },
] as const;

/**
 * The one primary-nav item to highlight: the most specific match. `/collections/new-arrivals`
 * would otherwise also match `/collections` and underline both.
 */
function activeNavItem(pathname: string): string | null {
  const matches = PRIMARY_NAV.filter((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
  return matches.sort((a, b) => b.to.length - a.to.length)[0]?.to ?? null;
}

export function AnnouncementBar() {
  const { data: config } = usePublicConfig();
  const messages = [
    deliveryPromise(config?.freeShippingThresholdPaise).headline,
    config ? `Easy ${config.returnWindowDays}-day returns & exchanges` : 'Easy returns & exchanges',
  ];
  return (
    <div className={styles.announcement}>
      <p>
        {messages.map((m, i) => (
          <span key={m}>
            {i > 0 ? <span className={styles.sep} aria-hidden>|</span> : null}
            {m}
          </span>
        ))}
      </p>
    </div>
  );
}

export function Header() {
  const { data: user } = useMe();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();

  // Close overlays on navigation (state adjusted during render, not in an effect).
  const navKey = location.pathname + location.search;
  const [lastNavKey, setLastNavKey] = useState(navKey);
  if (navKey !== lastNavKey) {
    setLastNavKey(navKey);
    setMenuOpen(false);
    setSearchOpen(false);
  }

  const accountHref = user ? '/account' : '/signin';
  const activeNav = activeNavItem(location.pathname);
  const { data: cart } = useCart();
  const bagCount = cart?.totals.itemCount ?? 0;

  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        <button type="button" className={styles.menuButton} onClick={() => setMenuOpen(true)} aria-label="Open menu">
          <Menu size={22} strokeWidth={1.6} aria-hidden />
        </button>

        <Link to="/" className={styles.logo} aria-label="AVERO home">
          AVERO
        </Link>

        <nav aria-label="Primary" className={styles.nav}>
          {PRIMARY_NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={item.to === activeNav ? styles.active : undefined}
              aria-current={item.to === activeNav ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className={styles.utilities}>
          <div className={styles.searchDesktop}>
            <SearchBox />
          </div>
          <button
            type="button"
            className={`${styles.iconLink} ${styles.searchToggle}`}
            aria-label="Search"
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search size={20} strokeWidth={1.6} aria-hidden />
          </button>
          <Link to="/wishlist" className={`${styles.iconLink} ${styles.hideMobile}`} aria-label="Wishlist">
            <Heart size={20} strokeWidth={1.6} aria-hidden />
          </Link>
          {user ? <NotificationBell className={styles.iconLink} countClassName={styles.count} /> : null}
          <Link to="/bag" className={styles.iconLink} aria-label={bagCount ? `Bag, ${bagCount} ${bagCount === 1 ? 'item' : 'items'}` : 'Bag'}>
            <ShoppingBag size={20} strokeWidth={1.6} aria-hidden />
            {bagCount ? (
              <span className={styles.count} aria-hidden>
                {bagCount > 9 ? '9+' : bagCount}
              </span>
            ) : null}
          </Link>
          <Link to={accountHref} className={`${styles.iconLink} ${styles.hideMobile}`} aria-label={user ? 'Account' : 'Sign in'}>
            <User size={20} strokeWidth={1.6} aria-hidden />
          </Link>
        </div>
      </div>

      {searchOpen ? (
        <div className={styles.searchMobile}>
          <SearchBox autoFocus onNavigate={() => setSearchOpen(false)} />
        </div>
      ) : null}

      <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} title="Menu" side="left">
        <nav aria-label="Mobile" className={styles.mobileNav}>
          <ul role="list">
            {PRIMARY_NAV.map((item) => (
              <li key={item.to}>
                <Link to={item.to}>{item.label}</Link>
              </li>
            ))}
          </ul>
          <ul role="list" className={styles.mobileSecondary}>
            <li>
              <Link to="/wishlist">
                <Heart size={18} aria-hidden /> Wishlist
              </Link>
            </li>
            <li>
              <Link to={accountHref}>
                <User size={18} aria-hidden /> {user ? 'Account' : 'Sign in'}
              </Link>
            </li>
            <li>
              <Link to="/track">Track an order</Link>
            </li>
            <li>
              <Link to="/help">Help</Link>
            </li>
          </ul>
        </nav>
      </Drawer>
    </header>
  );
}

const FOOTER_LINKS = [
  {
    title: 'Shop',
    links: [
      { to: '/c/men', label: 'Men' },
      { to: '/c/women', label: 'Women' },
      { to: '/collections/new-arrivals', label: 'New Arrivals' },
      { to: '/collections/best-sellers', label: 'Best Sellers' },
    ],
  },
  {
    title: 'Help',
    links: [
      { to: '/track', label: 'Track your order' },
      { to: '/help/shipping', label: 'Shipping' },
      { to: '/help/returns', label: 'Returns & exchanges' },
      { to: '/help/faq', label: 'FAQ' },
    ],
  },
  {
    title: 'AVERO',
    links: [
      { to: '/help/about', label: 'Our story' },
      { to: '/account/referrals', label: 'Refer a friend' },
      { to: '/help/rewards', label: 'AVERO Rewards' },
      { to: '/help/contact', label: 'Contact us' },
    ],
  },
];

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.footerInner}`}>
        <div className={styles.footerBrand}>
          <Link to="/" className={styles.logo}>
            AVERO
          </Link>
          <p className="meta">Modern footwear for everyday movement. Designed for comfort, made to last.</p>
        </div>
        {FOOTER_LINKS.map((col) => (
          <nav key={col.title} aria-label={col.title} className={styles.footerCol}>
            <h2 className="eyebrow">{col.title}</h2>
            <ul role="list">
              {col.links.map((l) => (
                <li key={l.to}>
                  <Link to={l.to}>{l.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className={`container ${styles.legal}`}>
        <p>© {new Date().getFullYear()} AVERO. A fictional brand — no real purchases are made.</p>
        <p>Prices include GST.</p>
      </div>
    </footer>
  );
}
