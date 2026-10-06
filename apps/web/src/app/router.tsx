import { createBrowserRouter } from 'react-router';
import { AccountLayout, AccountOverviewPage, SecurityPage } from '../features/account/AccountPage';
import { AccountWishlistPage, AddressesPage, ProfilePage, RecentlyViewedPage } from '../features/account/sections';
import { ForgotPasswordPage, ResetPasswordPage, SignInPage, SignUpPage, VerifyEmailPage } from '../features/auth/pages';
import { BagPage } from '../features/bag/BagPage';
import { HelpIndexPage, HelpTopicPage } from '../features/help/HelpPages';
import { ReferralLandingPage, ReferralsPage, RewardsPage } from '../features/loyalty/LoyaltyPages';
import { AccountReviewsPage, ReviewFormPage } from '../features/reviews/ReviewPages';
import { NotificationsPage } from '../features/notifications/Notifications';
import { AccountReturnsPage, ReturnDetailPage, ReturnRequestPage } from '../features/returns/ReturnPages';
import { CheckoutLayout } from '../features/checkout/CheckoutLayout';
import { CheckoutPage } from '../features/checkout/CheckoutPage';
import { PayPage, ProcessingPage } from '../features/checkout/PaymentPages';
import {
  AccountOrderPage,
  AccountOrdersPage,
  GuestOrderPage,
  OrderConfirmedPage,
  TrackOrderPage,
} from '../features/orders/OrderPages';
import { ListingPage } from '../features/catalog/ListingPage';
import { ProductPage } from '../features/catalog/ProductPage';
import { CollectionsPage } from '../features/collections/CollectionsPage';
import { HomePage } from '../features/home/HomePage';
import { WishlistPage } from '../features/wishlist/WishlistPage';
import { Layout, NotFoundPage, RequireAuth } from './Layout';

// Routes delivered in later phases (docs/ROADMAP.md) render a placeholder until built.


// Route map: docs/ROUTES.md
export const router = createBrowserRouter([
  {
    // Distraction-free chrome for checkout and the (simulated) payment gateway.
    element: <CheckoutLayout />,
    children: [
      { path: '/checkout', element: <CheckoutPage /> },
      { path: '/checkout/pay/:attemptId', element: <PayPage /> },
      { path: '/checkout/processing/:attemptId', element: <ProcessingPage /> },
    ],
  },
  {
    element: <Layout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/c/*', element: <ListingPage key="category" mode="category" /> },
      { path: '/collections', element: <CollectionsPage /> },
      { path: '/collections/:slug', element: <ListingPage key="collection" mode="collection" /> },
      { path: '/search', element: <ListingPage key="search" mode="search" /> },
      { path: '/p/:productSlug/:colorSlug?', element: <ProductPage /> },
      { path: '/bag', element: <BagPage /> },
      { path: '/wishlist', element: <WishlistPage /> },
      { path: '/signin', element: <SignInPage /> },
      { path: '/signup', element: <SignUpPage /> },
      { path: '/verify-email', element: <VerifyEmailPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/order/confirmed/:orderNumber', element: <OrderConfirmedPage /> },
      { path: '/track', element: <TrackOrderPage /> },
      { path: '/r/:code', element: <ReferralLandingPage /> },
      { path: '/orders/:orderNumber', element: <GuestOrderPage /> },
      { path: '/orders/:orderNumber/return', element: <ReturnRequestPage guest /> },
      { path: '/returns/:rma', element: <ReturnDetailPage guest /> },
      {
        element: <RequireAuth />,
        children: [
          {
            path: '/account',
            element: <AccountLayout />,
            children: [
              { index: true, element: <AccountOverviewPage /> },
              { path: 'profile', element: <ProfilePage /> },
              { path: 'addresses', element: <AddressesPage /> },
              { path: 'wishlist', element: <AccountWishlistPage /> },
              { path: 'recently-viewed', element: <RecentlyViewedPage /> },
              { path: 'security', element: <SecurityPage /> },
              { path: 'orders', element: <AccountOrdersPage /> },
              { path: 'orders/:orderNumber', element: <AccountOrderPage /> },
              { path: 'orders/:orderNumber/return', element: <ReturnRequestPage /> },
              { path: 'returns', element: <AccountReturnsPage /> },
              { path: 'returns/:rma', element: <ReturnDetailPage /> },
              { path: 'notifications', element: <NotificationsPage /> },
              { path: 'reviews', element: <AccountReviewsPage /> },
              { path: 'reviews/new/:orderItemId', element: <ReviewFormPage /> },
              { path: 'reviews/:reviewId/edit', element: <ReviewFormPage /> },
              { path: 'rewards', element: <RewardsPage /> },
              { path: 'referrals', element: <ReferralsPage /> },
            ],
          },
        ],
      },
      { path: '/help', element: <HelpIndexPage /> },
      { path: '/help/:topic', element: <HelpTopicPage /> },
      ...(import.meta.env.DEV
        ? [
            {
              path: '/dev/design',
              lazy: async () => ({ Component: (await import('../features/dev/DesignGalleryPage')).DesignGalleryPage }),
            },
          ]
        : []),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
