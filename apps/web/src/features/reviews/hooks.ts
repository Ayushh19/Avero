import type { MyReviewDto, ReviewFit, ReviewListDto, ReviewableItemDto } from '@avero/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { catalogKeys } from '../../lib/catalog';

export type ReviewSort = 'recent' | 'helpful' | 'rating_high' | 'rating_low';
export interface ReviewQuery {
  sort: ReviewSort;
  rating?: number;
  page: number;
}

const listKey = (slug: string) => ['reviews', 'product', slug] as const;

export function useProductReviews(slug: string, q: ReviewQuery) {
  const params = new URLSearchParams({ sort: q.sort, page: String(q.page), ...(q.rating ? { rating: String(q.rating) } : {}) });
  return useQuery({
    queryKey: [...listKey(slug), q],
    queryFn: ({ signal }) => api.get<ReviewListDto>(`/products/${slug}/reviews?${params}`, signal),
    placeholderData: keepPreviousData,
  });
}

/** Helpful is safe to show optimistically; the server answer settles the count. */
export function useHelpful(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, helpful }: { id: string; helpful: boolean }) =>
      api.post<{ helpfulCount: number; votedHelpful: boolean }>(`/reviews/${id}/helpful`, { helpful }),
    onMutate: ({ id, helpful }) => {
      qc.setQueriesData<ReviewListDto>({ queryKey: listKey(slug) }, (prev) =>
        prev
          ? {
              ...prev,
              reviews: prev.reviews.map((r) =>
                r.id === id && r.votedHelpful !== helpful ? { ...r, votedHelpful: helpful, helpfulCount: r.helpfulCount + (helpful ? 1 : -1) } : r,
              ),
            }
          : prev,
      );
    },
    onError: () => qc.invalidateQueries({ queryKey: listKey(slug) }),
  });
}

export function useReviewable(enabled = true) {
  return useQuery({
    queryKey: ['reviews', 'eligible'],
    queryFn: ({ signal }) => api.get<{ items: ReviewableItemDto[] }>('/reviews/eligible', signal),
    select: (d) => d.items,
    enabled,
  });
}

export function useMyReviews(enabled = true) {
  return useQuery({
    queryKey: ['reviews', 'mine'],
    queryFn: ({ signal }) => api.get<{ reviews: MyReviewDto[] }>('/reviews/mine', signal),
    select: (d) => d.reviews,
    enabled,
  });
}

export interface ReviewInput {
  rating: number;
  title: string;
  body: string;
  fit: ReviewFit | null;
}

/** After any change: refresh my lists, product reviews and the product's rating. */
function useAfterChange() {
  const qc = useQueryClient();
  return (productSlug?: string) => {
    void qc.invalidateQueries({ queryKey: ['reviews'] });
    if (productSlug) void qc.invalidateQueries({ queryKey: catalogKeys.product(productSlug) });
    void qc.invalidateQueries({ queryKey: ['loyalty'] });
  };
}

export function useSaveReview() {
  const after = useAfterChange();
  return useMutation({
    mutationFn: (v: { input: ReviewInput; orderItemId?: string; reviewId?: string; productSlug: string }) =>
      v.reviewId ? api.patch<{ id: string }>(`/reviews/${v.reviewId}`, v.input) : api.post<{ id: string }>('/reviews', { orderItemId: v.orderItemId, ...v.input }),
    onSuccess: (_d, v) => after(v.productSlug),
  });
}

export function useDeleteReview() {
  const after = useAfterChange();
  return useMutation({
    mutationFn: (v: { id: string; productSlug: string }) => api.delete<void>(`/reviews/${v.id}`),
    onSuccess: (_d, v) => after(v.productSlug),
  });
}
