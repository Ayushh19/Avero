import type { CreateReturnInput, ReturnDto, ReturnOptionsDto, ReturnSummaryDto } from '@avero/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useIntentKey } from '../checkout/hooks';
import { ordersKey, withToken } from '../orders/hooks';

export const returnsKey = ['returns'] as const;

export function useReturnOptions(orderNumber: string | undefined, token?: string | null) {
  return useQuery({
    queryKey: ['orders', orderNumber, 'return-options', token ?? null],
    queryFn: ({ signal }) => api.get<ReturnOptionsDto>(withToken(`/orders/${orderNumber}/return-options`, token), signal),
    enabled: Boolean(orderNumber),
    retry: false,
  });
}

export function useCreateReturn(token?: string | null) {
  const qc = useQueryClient();
  const intent = useIntentKey();
  return useMutation({
    mutationFn: (input: CreateReturnInput) => api.post<{ return: ReturnDto }>(withToken('/returns', token), input, { idempotencyKey: intent.get() }),
    onSettled: (_d, err) => intent.settle(err),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ordersKey });
      void qc.invalidateQueries({ queryKey: returnsKey });
    },
  });
}

export function useReturns() {
  return useQuery({
    queryKey: returnsKey,
    queryFn: ({ signal }) => api.get<{ returns: ReturnSummaryDto[] }>('/returns', signal),
    select: (d) => d.returns,
  });
}

export function useReturn(rma: string | undefined, token?: string | null) {
  return useQuery({
    queryKey: ['returns', rma, token ?? null],
    queryFn: ({ signal }) => api.get<{ return: ReturnDto }>(withToken(`/returns/${rma}`, token), signal),
    select: (d) => d.return,
    enabled: Boolean(rma),
    retry: false,
  });
}

export function useCancelReturn(rma: string, token?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ return: ReturnDto }>(withToken(`/returns/${rma}/cancel`, token)),
    onSuccess: (data) => {
      qc.setQueryData(['returns', rma, token ?? null], data);
      void qc.invalidateQueries({ queryKey: ordersKey });
      void qc.invalidateQueries({ queryKey: returnsKey });
    },
  });
}
