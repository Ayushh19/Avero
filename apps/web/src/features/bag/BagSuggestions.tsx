import type { ListingItemDto } from '@avero/shared';
import { useQuery } from '@tanstack/react-query';
import { ProductCard, ProductRail } from '../../components/ui/Merch';
import { api } from '../../lib/api';
import { WishlistCardButton } from '../wishlist/WishlistButton';

/** "Frequently bought together" for the first item in the bag, minus anything already in it. */
export function BagSuggestions({ slugs }: { slugs: string[] }) {
  const first = slugs[0];
  const fbt = useQuery({
    queryKey: ['catalog', 'fbt', first],
    queryFn: ({ signal }) => api.get<{ items: ListingItemDto[] }>(`/products/${encodeURIComponent(first!)}/frequently-bought-together`, signal),
    select: (d) => d.items,
    enabled: Boolean(first),
    staleTime: 5 * 60_000,
  });
  const inBag = new Set(slugs);
  const items = (fbt.data ?? []).filter((i) => !inBag.has(i.href.split('/')[2] ?? ''));
  if (items.length === 0) return null;
  return (
    <section className="section">
      <ProductRail title="Frequently bought together">
        {items.map((item) => (
          <li key={item.colorwayId}>
            <ProductCard product={item} sizes="(min-width: 1024px) 22vw, 60vw" wishlistButton={<WishlistCardButton item={item} />} />
          </li>
        ))}
      </ProductRail>
    </section>
  );
}
