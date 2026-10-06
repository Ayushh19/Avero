import type { ComponentType } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';
import { CheckoutLayout } from '../features/checkout/CheckoutLayout';
import { HomePage } from '../features/home/HomePage';
import { Layout, NotFoundPage, PageFallback, RequireAuth } from './Layout';

/**
 * Pages load on demand: each feature module becomes its own chunk, fetched on first visit to one of
 * its routes (the router keeps the current page up, with a progress bar, meanwhile). The home page
 * and the shells stay in the entry bundle.
 */
const page =
  <M,>(load: () => Promise<M>, pick: (m: M) => ComponentType) =>
  async () => ({ Component: pick(await load()) });

const account = () => import('../features/account/AccountPage');
const sections = () => import('../features/account/sections');
const auth = () => import('../features/auth/pages');
const loyalty = () => import('../features/loyalty/LoyaltyPages');
const reviews = () => import('../features/reviews/ReviewPages');
const returns = () => import('../features/returns/ReturnPages');
const payments = () => import('../features/checkout/PaymentPages');
const orders = () => import('../features/orders/OrderPages');
const help = () => import('../features/help/HelpPages');
const listing = () => import('../features/catalog/ListingPage');
const product = () => import('../features/catalog/ProductPage');

/**
 * While a lazy page's code loads on the first visit, its parent layout (header, footer) still
 * renders; only the page area shows the fallback.
 */
function withPageFallbacks(routes: RouteObject[]): RouteObject[] {
  return routes.map((r) => {
    const children = r.children ? withPageFallbacks(r.children) : undefined;
    const route = (r.lazy ? { ...r, hydrateFallbackElement: <PageFallback /> } : { ...r }) as RouteObject;
    if (children) route.children = children;
    return route;
  });
}

/** Warm the chunks a shopper is most likely to need next, once the first page is up. */
export function prefetchLikelyPages() {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
  idle(() => {
    void listing();
    void product();
    void import('../features/bag/BagPage');
  });
}

// Route map: docs/ROUTES.md
export const router = createBrowserRouter(withPageFallbacks([
  {
    // Distraction-free chrome for checkout and the (simulated) payment gateway.
    element: <CheckoutLayout />,
    children: [
      { path: '/checkout', lazy: page(() => import('../features/checkout/CheckoutPage'), (m) => m.CheckoutPage) },
      { path: '/checkout/pay/:attemptId', lazy: page(payments, (m) => m.PayPage) },
      { path: '/checkout/processing/:attemptId', lazy: page(payments, (m) => m.ProcessingPage) },
    ],
  },
  {
    element: <Layout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/c/*', lazy: async () => { const { ListingPage } = await listing(); return { element: <ListingPage key="category" mode="category" /> }; } },
      { path: '/collections', lazy: page(() => import('../features/collections/CollectionsPage'), (m) => m.CollectionsPage) },
      { path: '/collections/:slug', lazy: async () => { const { ListingPage } = await listing(); return { element: <ListingPage key="collection" mode="collection" /> }; } },
      { path: '/search', lazy: async () => { const { ListingPage } = await listing(); return { element: <ListingPage key="search" mode="search" /> }; } },
      { path: '/p/:productSlug/:colorSlug?', lazy: page(product, (m) => m.ProductPage) },
      { path: '/bag', lazy: page(() => import('../features/bag/BagPage'), (m) => m.BagPage) },
      { path: '/wishlist', lazy: page(() => import('../features/wishlist/WishlistPage'), (m) => m.WishlistPage) },
      { path: '/signin', lazy: page(auth, (m) => m.SignInPage) },
      { path: '/signup', lazy: page(auth, (m) => m.SignUpPage) },
      { path: '/verify-email', lazy: page(auth, (m) => m.VerifyEmailPage) },
      { path: '/forgot-password', lazy: page(auth, (m) => m.ForgotPasswordPage) },
      { path: '/reset-password', lazy: page(auth, (m) => m.ResetPasswordPage) },
      { path: '/order/confirmed/:orderNumber', lazy: page(orders, (m) => m.OrderConfirmedPage) },
      { path: '/track', lazy: page(orders, (m) => m.TrackOrderPage) },
      { path: '/r/:code', lazy: page(loyalty, (m) => m.ReferralLandingPage) },
      { path: '/orders/:orderNumber', lazy: page(orders, (m) => m.GuestOrderPage) },
      { path: '/orders/:orderNumber/return', lazy: async () => { const { ReturnRequestPage } = await returns(); return { element: <ReturnRequestPage guest /> }; } },
      { path: '/returns/:rma', lazy: async () => { const { ReturnDetailPage } = await returns(); return { element: <ReturnDetailPage guest /> }; } },
      {
        element: <RequireAuth />,
        children: [
          {
            path: '/account',
            lazy: page(account, (m) => m.AccountLayout),
            children: [
              { index: true, lazy: page(account, (m) => m.AccountOverviewPage) },
              { path: 'profile', lazy: page(sections, (m) => m.ProfilePage) },
              { path: 'addresses', lazy: page(sections, (m) => m.AddressesPage) },
              { path: 'wishlist', lazy: page(sections, (m) => m.AccountWishlistPage) },
              { path: 'recently-viewed', lazy: page(sections, (m) => m.RecentlyViewedPage) },
              { path: 'security', lazy: page(account, (m) => m.SecurityPage) },
              { path: 'orders', lazy: page(orders, (m) => m.AccountOrdersPage) },
              { path: 'orders/:orderNumber', lazy: page(orders, (m) => m.AccountOrderPage) },
              { path: 'orders/:orderNumber/return', lazy: page(returns, (m) => m.ReturnRequestPage) },
              { path: 'returns', lazy: page(returns, (m) => m.AccountReturnsPage) },
              { path: 'returns/:rma', lazy: page(returns, (m) => m.ReturnDetailPage) },
              { path: 'notifications', lazy: page(() => import('../features/notifications/Notifications'), (m) => m.NotificationsPage) },
              { path: 'reviews', lazy: page(reviews, (m) => m.AccountReviewsPage) },
              { path: 'reviews/new/:orderItemId', lazy: page(reviews, (m) => m.ReviewFormPage) },
              { path: 'reviews/:reviewId/edit', lazy: page(reviews, (m) => m.ReviewFormPage) },
              { path: 'rewards', lazy: page(loyalty, (m) => m.RewardsPage) },
              { path: 'referrals', lazy: page(loyalty, (m) => m.ReferralsPage) },
            ],
          },
        ],
      },
      { path: '/help', lazy: page(help, (m) => m.HelpIndexPage) },
      { path: '/help/:topic', lazy: page(help, (m) => m.HelpTopicPage) },
      // Shown only when the API has SIMULATION_TOOLS=true (the page checks /config).
      {
        path: '/dev/simulate',
        lazy: page(() => import('../features/dev/SimulationPage'), (m) => m.SimulationPage),
      },
      ...(import.meta.env.DEV
        ? [
            {
              path: '/dev/design',
              lazy: page(() => import('../features/dev/DesignGalleryPage'), (m) => m.DesignGalleryPage),
            },
          ]
        : []),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]));
