import type { ListingItemDto, WishlistItemDto } from '@avero/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../components/ui/Overlay';
import { api, errorMessage } from '../../lib/api';
import { createLocalStore } from '../../lib/storage';
import { useMe } from '../auth/hooks';

/** Guests keep their wishlist on the device; it is merged into the account on sign-in. */
export const guestWishlist = createLocalStore<{ colorwayId: string; addedAt: number; pricePaise: number }[]>('avero:wishlist', []);

export const wishlistKey = ['wishlist'] as const;

/** Unified wishlist: server for members, device storage (+ public card lookup) for guests. */
export function useWishlist() {
  const { data: user, isPending } = useMe();
  const local = guestWishlist.useValue();
  const ids = local.map((l) => l.colorwayId);
  return useQuery({
    queryKey: user ? wishlistKey : [...wishlistKey, 'guest', ids.join(',')],
    enabled: !isPending,
    queryFn: async ({ signal }): Promise<WishlistItemDto[]> => {
      if (user) return (await api.get<{ items: WishlistItemDto[] }>('/wishlist', signal)).items;
      if (ids.length === 0) return [];
      const { items } = await api.get<{ items: ListingItemDto[] }>(`/products/by-colorway?ids=${ids.join(',')}`, signal);
      return items.map((i) => {
        const entry = local.find((l) => l.colorwayId === i.colorwayId);
        return { ...i, addedAt: new Date(entry?.addedAt ?? Date.now()).toISOString(), addedPricePaise: entry?.pricePaise ?? null };
      });
    },
    staleTime: 30_000,
  });
}

/** Fast membership check used by every heart button. */
export function useWishlistIds(): Set<string> {
  const { data: user } = useMe();
  const local = guestWishlist.useValue();
  const server = useQuery({
    queryKey: wishlistKey,
    queryFn: ({ signal }) => api.get<{ items: WishlistItemDto[] }>('/wishlist', signal).then((d) => d.items),
    enabled: Boolean(user),
    staleTime: 30_000,
  });
  return new Set(user ? (server.data ?? []).map((i) => i.colorwayId) : local.map((l) => l.colorwayId));
}

export function useToggleWishlist() {
  const { data: user } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ item, on }: { item: Pick<ListingItemDto, 'colorwayId' | 'name' | 'pricePaise'>; on: boolean }) => {
      if (!user) {
        guestWishlist.set((prev) =>
          on
            ? [{ colorwayId: item.colorwayId, addedAt: Date.now(), pricePaise: item.pricePaise }, ...prev.filter((p) => p.colorwayId !== item.colorwayId)]
            : prev.filter((p) => p.colorwayId !== item.colorwayId),
        );
        return;
      }
      if (on) await api.put(`/wishlist/${item.colorwayId}`, {});
      else await api.delete(`/wishlist/${item.colorwayId}`);
    },
    // Optimistic: the heart flips instantly; rolled back on error.
    onMutate: async ({ item, on }) => {
      if (!user) return undefined;
      await qc.cancelQueries({ queryKey: wishlistKey });
      const previous = qc.getQueryData<WishlistItemDto[]>(wishlistKey);
      qc.setQueryData<WishlistItemDto[]>(wishlistKey, (prev = []) =>
        on
          ? [{ ...(item as WishlistItemDto), addedAt: new Date().toISOString(), addedPricePaise: item.pricePaise }, ...prev]
          : prev.filter((p) => p.colorwayId !== item.colorwayId),
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) qc.setQueryData(wishlistKey, context.previous);
      toast.error(errorMessage(err));
    },
    onSuccess: (_d, { item, on }) => {
      toast.show(on ? `Saved ${item.name} to your wishlist` : `Removed ${item.name} from your wishlist`, {
        tone: on ? 'success' : 'info',
      });
    },
    onSettled: () => {
      if (user) void qc.invalidateQueries({ queryKey: wishlistKey });
    },
  });
}
