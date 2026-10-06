import { Compass } from 'lucide-react';
import { Navigate, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { AnnouncementBar, Footer, Header } from '../components/layout/SiteChrome';
import { ButtonLink } from '../components/ui/Button';
import { EmptyState, Skeleton } from '../components/ui/Feedback';
import { useMe } from '../features/auth/hooks';
import { SessionSync } from '../features/auth/SessionSync';
import { BagProvider } from '../features/bag/BagDrawer';

export function Layout() {
  return (
    <BagProvider>
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
        icon={Compass}
        title="This page took a different path"
        body="The page you're looking for doesn't exist or has moved."
        action={<ButtonLink to="/">Back to home</ButtonLink>}
      />
    </main>
  );
}
