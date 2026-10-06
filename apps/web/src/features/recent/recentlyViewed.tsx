import type { ListingItemDto } from '@avero/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ProductCard, ProductRail } from '../../components/ui/Merch';
import { api } from '../../lib/api';
import { recentlyViewed, rememberView, type RecentlyViewedEntry } from '../../lib/storage';
import { useMe } from '../auth/hooks';
import { WishlistCardButton } from '../wishlist/WishlistButton';

const key = ['recently-viewed'] as const;

/** Records a PDP view on the device and, for members, on the server. */
export function useRecordView(entry: Omit<RecentlyViewedEntry, 'viewedAt'> | null) {
  const { data: user } = useMe();
  const qc = useQueryClient();
  const id = entry?.colorwayId;
  useEffect(() => {
    if (!entry) return;
    rememberView(entry);
    if (user) {
      api.post('/recently-viewed', { colorwayIds: [entry.colorwayId] }).then(
        () => qc.invalidateQueries({ queryKey: key }),
        () => undefined,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- record once per colourway
  }, [id, user?.id]);
}

/** Members: server list (cross-device). Guests: device list, refreshed through the public card lookup. */
export function useRecentlyViewed(excludeColorwayId?: string) {
  const { data: user, isPending } = useMe();
  const local = recentlyViewed.useValue();
  const ids = local.map((l) => l.colorwayId);
  const query = useQuery({
    queryKey: user ? key : [...key, 'guest', ids.join(',')],
    enabled: !isPending && (Boolean(user) || ids.length > 0),
    queryFn: async ({ signal }) =>
      user
        ? (await api.get<{ items: ListingItemDto[] }>('/recently-viewed', signal)).items
        : (await api.get<{ items: ListingItemDto[] }>(`/products/by-colorway?ids=${ids.join(',')}`, signal)).items,
    staleTime: 30_000,
  });
  return (query.data ?? []).filter((i) => i.colorwayId !== excludeColorwayId);
}

export function RecentlyViewedRail({ exclude, title = 'Recently viewed' }: { exclude?: string; title?: string }) {
  const items = useRecentlyViewed(exclude);
  if (items.length === 0) return null;
  return (
    <ProductRail title={title}>
      {items.slice(0, 12).map((item) => (
        <li key={item.colorwayId}>
          <ProductCard product={item} sizes="(min-width: 1024px) 22vw, 60vw" wishlistButton={<WishlistCardButton item={item} />} />
        </li>
      ))}
    </ProductRail>
  );
}
