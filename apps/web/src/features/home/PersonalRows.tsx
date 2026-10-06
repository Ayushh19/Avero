import type { PersonalRowDto } from '@avero/shared';
import { useQuery } from '@tanstack/react-query';
import { ProductCard, ProductRail } from '../../components/ui/Merch';
import { api } from '../../lib/api';
import { recentlyViewed } from '../../lib/storage';
import { useMe } from '../auth/hooks';
import { WishlistCardButton } from '../wishlist/WishlistButton';

/** Home rows for returning visitors: "Picked for you" and wishlist price drops. */
export function PersonalRows() {
  const { data: user, isPending } = useMe();
  const viewed = recentlyViewed.useValue();
  const ids = user ? [] : viewed.slice(0, 20).map((v) => v.colorwayId);
  const rows = useQuery({
    queryKey: ['home', 'personal', user?.id ?? 'guest', ids.join(',')],
    queryFn: ({ signal }) => api.get<{ rows: PersonalRowDto[] }>(`/home/personal${ids.length ? `?viewed=${ids.join(',')}` : ''}`, signal),
    select: (d) => d.rows,
    enabled: !isPending && (Boolean(user) || ids.length > 0),
    staleTime: 60_000,
  });
  if (!rows.data?.length) return null;
  return (
    <>
      {rows.data.map((row) => (
        <div key={row.key} className="container section">
          <ProductRail title={row.title}>
            {row.items.map((item) => (
              <li key={item.colorwayId}>
                <ProductCard product={item} sizes="(min-width: 1024px) 22vw, 60vw" wishlistButton={<WishlistCardButton item={item} />} />
              </li>
            ))}
          </ProductRail>
        </div>
      ))}
    </>
  );
}
