import type { CartDto, CartMutationResponse } from '@avero/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { useToast } from '../../components/ui/Overlay';
import { ApiError, api, errorMessage } from '../../lib/api';

export const cartKey = ['cart'] as const;

export function useCart() {
  return useQuery({
    queryKey: cartKey,
    queryFn: ({ signal }) => api.get<{ cart: CartDto }>('/cart', signal),
    select: (d) => d.cart,
    staleTime: 10_000,
  });
}

/** Writes the server's bag into the cache; mutations never need a refetch. */
function useApplyCart() {
  const qc = useQueryClient();
  return (cart: CartDto) => qc.setQueryData<{ cart: CartDto }>(cartKey, { cart });
}

/** On a version conflict the server sends the fresh bag; show it instead of failing silently. */
function useHandleCartError() {
  const apply = useApplyCart();
  const toast = useToast();
  const qc = useQueryClient();
  return (err: unknown) => {
    if (err instanceof ApiError && err.code === 'CART_VERSION_CONFLICT') {
      const fresh = (err.details as { cart?: CartDto } | undefined)?.cart;
      if (fresh) apply(fresh);
      else void qc.invalidateQueries({ queryKey: cartKey });
    } else {
      void qc.invalidateQueries({ queryKey: cartKey });
    }
    toast.error(errorMessage(err));
  };
}

interface BagUi {
  open: () => void;
}
export const BagUiContext = createContext<BagUi>({ open: () => undefined });
export const useBagUi = () => useContext(BagUiContext);

export function useAddToBag() {
  const apply = useApplyCart();
  const toast = useToast();
  const bag = useBagUi();
  return useMutation({
    mutationFn: (input: { skuId: string; qty?: number }) => api.post<CartMutationResponse>('/cart/items', { qty: 1, ...input }),
    onSuccess: ({ cart, notice }) => {
      apply(cart);
      if (notice) toast.show(notice);
      bag.open();
    },
    // Errors are shown inline by the caller (e.g. "just sold out" next to the size grid).
  });
}

export function useUpdateLine() {
  const apply = useApplyCart();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useHandleCartError();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; qty?: number; savedForLater?: boolean }) => {
      const version = qc.getQueryData<{ cart: CartDto }>(cartKey)?.cart.version;
      return api.patch<CartMutationResponse>(`/cart/items/${id}`, { ...patch, expectedVersion: version || undefined });
    },
    // Optimistic quantity change: safe because the server response replaces it right after.
    onMutate: async ({ id, qty }) => {
      if (qty === undefined) return;
      await qc.cancelQueries({ queryKey: cartKey });
      qc.setQueryData<{ cart: CartDto }>(cartKey, (prev) =>
        prev ? { cart: { ...prev.cart, lines: prev.cart.lines.map((l) => (l.id === id ? { ...l, qty } : l)) } } : prev,
      );
    },
    onSuccess: ({ cart, notice }) => {
      apply(cart);
      if (notice) toast.show(notice);
    },
    onError,
  });
}

export function useRemoveLine() {
  const apply = useApplyCart();
  const onError = useHandleCartError();
  return useMutation({
    mutationFn: (id: string) => api.delete<CartMutationResponse>(`/cart/items/${id}`),
    onSuccess: ({ cart }) => apply(cart),
    onError,
  });
}

export function useAcknowledgePrices() {
  const apply = useApplyCart();
  return useMutation({
    mutationFn: () => api.post<CartMutationResponse>('/cart/acknowledge-prices'),
    onSuccess: ({ cart }) => apply(cart),
  });
}
