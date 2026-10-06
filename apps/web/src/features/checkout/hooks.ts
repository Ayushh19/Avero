import type {
  CheckoutSessionDto,
  CheckoutSessionPatch,
  OrderDto,
  PaymentAttemptDto,
  PaymentAttemptStatusDto,
  PaymentMethod,
  QuoteDto,
} from '@avero/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { ApiError, api, newIdempotencyKey } from '../../lib/api';

export const sessionKey = ['checkout', 'session'] as const;

/** Creates or resumes the server-side checkout for the current bag (refresh-safe). */
export function useCheckoutSession() {
  return useQuery({
    queryKey: sessionKey,
    queryFn: () => api.post<{ session: CheckoutSessionDto }>('/checkout/session'),
    select: (d) => d.session,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

function useSetSession() {
  const qc = useQueryClient();
  return (session: CheckoutSessionDto) => qc.setQueryData(sessionKey, { session });
}

export function usePatchSession(sessionId: string | undefined) {
  const set = useSetSession();
  return useMutation({
    mutationFn: (patch: CheckoutSessionPatch) =>
      api.patch<{ session: CheckoutSessionDto }>(`/checkout/session/${sessionId}`, patch),
    onSuccess: ({ session }) => set(session),
  });
}

export function useQuote(sessionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ quote: QuoteDto }>(`/checkout/session/${sessionId}/quote`),
    onSuccess: ({ quote }) => storeQuote(qc, quote),
  });
}

function storeQuote(qc: ReturnType<typeof useQueryClient>, quote: QuoteDto) {
  qc.setQueryData<{ session: CheckoutSessionDto }>(sessionKey, (prev) => (prev ? { session: { ...prev.session, quote } } : prev));
}

/**
 * One Idempotency-Key per *intent*: reused when retrying after a network failure, replaced after
 * the server gave a definite answer (a 4xx is stored and replayed for the same key).
 */
export function useIntentKey() {
  const key = useRef<string | null>(null);
  return {
    get: () => (key.current ??= newIdempotencyKey()),
    settle: (err?: unknown) => {
      const definite = !err || (err instanceof ApiError && err.status > 0 && err.status < 500);
      if (definite) key.current = null;
    },
  };
}

export function usePlaceOrder() {
  const qc = useQueryClient();
  const intent = useIntentKey();
  return useMutation({
    mutationFn: (input: { sessionId: string; quoteHash: string }) =>
      api.post<{ order: OrderDto }>('/checkout/place-order', input, { idempotencyKey: intent.get() }),
    onSettled: (_d, err) => intent.settle(err),
    onError: (err) => {
      // The server re-priced: show the shopper the fresh quote it sent back.
      const quote = err instanceof ApiError ? (err.details as { quote?: QuoteDto } | undefined)?.quote : undefined;
      if (quote) storeQuote(qc, quote);
    },
  });
}

export function useStartPayment() {
  const intent = useIntentKey();
  return useMutation({
    mutationFn: (input: { orderNumber: string; method: PaymentMethod }) =>
      api.post<{ attempt: PaymentAttemptDto; gatewayUrl: string }>('/payments/attempts', input, { idempotencyKey: intent.get() }),
    onSettled: (_d, err) => intent.settle(err),
  });
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']);

/** Polls the attempt until it settles (and the order has caught up with a success). */
export function useAttemptStatus(attemptId: string | undefined) {
  return useQuery({
    queryKey: ['payments', 'attempt', attemptId],
    queryFn: ({ signal }) => api.get<PaymentAttemptStatusDto>(`/payments/attempts/${attemptId}`, signal),
    enabled: Boolean(attemptId),
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return 1500;
      if (!TERMINAL.has(d.attempt.status)) return d.attempt.status === 'PENDING' ? 3000 : 1500;
      return d.attempt.status === 'SUCCEEDED' && d.order.status === 'PENDING_PAYMENT' ? 1500 : false;
    },
    refetchIntervalInBackground: true,
  });
}
