import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useToast } from '../../components/ui/Overlay';
import { api } from '../../lib/api';
import { recentlyViewed } from '../../lib/storage';
import { cartKey } from '../bag/hooks';
import { guestWishlist, wishlistKey } from '../wishlist/hooks';
import { useMe } from './hooks';

/**
 * When a session starts (password, sign-up or Google redirect), fold this device's guest data into
 * the account: wishlist is merged then cleared locally; recently viewed is synced. The bag is
 * merged server-side during sign-in, so we only refetch it.
 */
export function SessionSync() {
  const { data: user } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const lastUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const id = user?.id ?? null;
    if (lastUserId.current === id) return;
    const first = lastUserId.current === undefined;
    lastUserId.current = id;
    if (!first || id) void qc.invalidateQueries({ queryKey: cartKey });
    if (!id) return;

    const wish = guestWishlist.get().map((w) => w.colorwayId);
    if (wish.length) {
      api
        .post<{ added: number }>('/wishlist/merge', { colorwayIds: wish })
        .then(({ added }) => {
          guestWishlist.set([]);
          void qc.invalidateQueries({ queryKey: wishlistKey });
          if (added > 0) toast.show(`Saved ${added} ${added === 1 ? 'item' : 'items'} from this device to your wishlist`, { tone: 'success' });
        })
        .catch(() => undefined); // kept locally; retried next session
    }

    const viewed = recentlyViewed.get().map((r) => r.colorwayId).slice(0, 20);
    if (viewed.length) {
      api.post('/recently-viewed', { colorwayIds: viewed }).then(
        () => qc.invalidateQueries({ queryKey: ['recently-viewed'] }),
        () => undefined,
      );
    }
  }, [user?.id, qc, toast]);

  return null;
}
