import '@fontsource-variable/inter';
import '@fontsource-variable/manrope';
import './styles/tokens.css';
import './styles/base.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { router } from './app/router';
import { ToastProvider } from './components/ui/Overlay';
import { ApiError } from './lib/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Refetch on focus catches changes made on another device (e.g. bag edits).
      refetchOnWindowFocus: true,
      retry: (count, error) =>
        count < 2 && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500),
    },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
