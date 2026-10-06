import { ArrowLeft, Lock } from 'lucide-react';
import { Link, Outlet, ScrollRestoration } from 'react-router';
import { SessionSync } from '../auth/SessionSync';
import styles from './Checkout.module.css';

/** Distraction-free chrome for checkout and payment (docs/DESIGN.md §7): logo + secure note only. */
export function CheckoutLayout() {
  return (
    <>
      <SessionSync />
      <ScrollRestoration />
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className={styles.header}>
        <div className={`container ${styles.headerInner}`}>
          <Link to="/bag" className={styles.back} aria-label="Back to bag">
            <ArrowLeft size={16} aria-hidden /> <span>Bag</span>
          </Link>
          <Link to="/" className={styles.logo} aria-label="AVERO home">
            AVERO
          </Link>
          <p className={styles.secure}>
            <Lock size={14} aria-hidden /> <span>Secure checkout</span>
          </p>
        </div>
      </header>
      <div id="main" tabIndex={-1} className={styles.main}>
        <Outlet />
      </div>
      <footer className={styles.footer}>
        <p className="container meta">Payments on AVERO are simulated for this demo — no real money moves and card details never leave your browser.</p>
      </footer>
    </>
  );
}
