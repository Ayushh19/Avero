import type { ListingItemDto } from '@avero/shared';
import { Heart } from 'lucide-react';
import { IconButton } from '../../components/ui/Button';
import { WishButton } from '../../components/ui/Merch';
import { useToggleWishlist, useWishlistIds } from './hooks';

type Item = Pick<ListingItemDto, 'colorwayId' | 'name' | 'pricePaise'>;

export function WishlistCardButton({ item }: { item: Item }) {
  const ids = useWishlistIds();
  const toggle = useToggleWishlist();
  const on = ids.has(item.colorwayId);
  return <WishButton name={item.name} pressed={on} onClick={() => toggle.mutate({ item, on: !on })} />;
}

/** Square bordered heart used next to "Add to bag" on the PDP. */
export function WishlistIconButton({ item }: { item: Item }) {
  const ids = useWishlistIds();
  const toggle = useToggleWishlist();
  const on = ids.has(item.colorwayId);
  return (
    <IconButton
      label={on ? 'Remove from wishlist' : 'Add to wishlist'}
      shape="square"
      bordered
      pressed={on}
      onClick={() => toggle.mutate({ item, on: !on })}
    >
      <Heart size={20} strokeWidth={1.6} fill={on ? 'currentColor' : 'none'} aria-hidden />
    </IconButton>
  );
}
