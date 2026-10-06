import { Compass } from 'lucide-react';
import { Navigate, Outlet, ScrollRestoration, useLocation, useNavigation } from 'react-router';
import { AnnouncementBar, Footer, Header } from '../components/layout/SiteChrome';
import { ButtonLink } from '../components/ui/Button';
import { EmptyState, Skeleton } from '../components/ui/Feedback';
import { useMe } from '../features/auth/hooks';
import { SessionSync } from '../features/auth/SessionSync';
import { BagProvider } from '../features/bag/BagDrawer';
import styles from './Layout.module.css';

export function Layout() {
  return (
    <BagProvider>
      <NavigationProgress />
      <SessionSync />
      <ScrollRestoration getKey={(location) => location.pathname + location.search} />
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <AnnouncementBar />
      <Header />
      <div id="main" tabIndex={-1}>
        <Outlet />
      </div>
      <Footer />
    </BagProvider>
  );
}

/** Thin bar while the next page's code loads (only shows if it takes a moment). */
function NavigationProgress() {
  const navigation = useNavigation();
  if (navigation.state === 'idle') return null;
  return <div className={styles.progress} role="progressbar" aria-label="Loading page" />;
}

/** First paint while the router fetches the code for the page being opened. */
export function PageFallback() {
  return (
    <div className={styles.fallback} role="status" aria-live="polite">
      <span className="visually-hidden">Loading…</span>
    </div>
  );
}

/** Gate for signed-in routes; preserves the destination for after sign-in. */
export function RequireAuth() {
  const { data: user, isPending } = useMe();
  const location = useLocation();
  if (isPending) {
    return (
      <main className="container section" role="status" aria-live="polite">
        <span className="visually-hidden">Loading…</span>
        <Skeleton width="40%" height={36} />
      </main>
    );
  }
  if (!user) {
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/signin?returnTo=${returnTo}`} replace />;
  }
  return <Outlet />;
}

export function NotFoundPage() {
  return (
    <main className="container">
      <EmptyState
        headingLevel={1}
        icon={Compass}
        title="This page took a different path"
        body="The page you're looking for doesn't exist or has moved."
        action={<ButtonLink to="/">Back to home</ButtonLink>}
      />
    </main>
  );
}
