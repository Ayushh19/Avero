import type {
  CategoryNodeDto,
  CollectionDto,
  DeliveryEstimateDto,
  HomeDto,
  ListingItemDto,
  ListingResponse,
  ProductDetailDto,
  SuggestResponse,
} from '@avero/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from './api';

export const catalogKeys = {
  home: ['catalog', 'home'] as const,
  listing: (params: string) => ['catalog', 'listing', params] as const,
  product: (slug: string) => ['catalog', 'product', slug] as const,
  recommendations: (slug: string) => ['catalog', 'recommendations', slug] as const,
  suggest: (q: string) => ['catalog', 'suggest', q] as const,
};

export function useHome() {
  return useQuery({
    queryKey: catalogKeys.home,
    queryFn: ({ signal }) => api.get<HomeDto>('/home', signal),
    staleTime: 60_000,
  });
}

/** Listing params (already URL-encoded, without offset). Pages are fetched with "load more". */
export function useListing(params: URLSearchParams, pageSize = 24) {
  const key = params.toString();
  return useInfiniteQuery({
    queryKey: catalogKeys.listing(key),
    queryFn: ({ signal, pageParam }) => {
      const p = new URLSearchParams(params);
      p.set('offset', String(pageParam));
      p.set('limit', String(pageSize));
      return api.get<ListingResponse>(`/products?${p}`, signal);
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useProduct(slug: string) {
  return useQuery({
    queryKey: catalogKeys.product(slug),
    queryFn: ({ signal }) => api.get<{ product: ProductDetailDto }>(`/products/${encodeURIComponent(slug)}`, signal),
    select: (d) => d.product,
    staleTime: 15_000,
  });
}

export function useRecommendations(slug: string) {
  return useQuery({
    queryKey: catalogKeys.recommendations(slug),
    queryFn: ({ signal }) => api.get<{ items: ListingItemDto[] }>(`/products/${encodeURIComponent(slug)}/recommendations`, signal),
    select: (d) => d.items,
    staleTime: 60_000,
  });
}

export function useSuggest(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: catalogKeys.suggest(query.toLowerCase()),
    queryFn: ({ signal }) => api.get<SuggestResponse>(`/search/suggest?q=${encodeURIComponent(query)}`, signal),
    enabled: query.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useTrending() {
  return useQuery({
    queryKey: ['catalog', 'trending'],
    queryFn: ({ signal }) => api.get<{ queries: string[] }>('/search/trending', signal),
    select: (d) => d.queries,
    staleTime: 5 * 60_000,
  });
}

export function useCollections() {
  return useQuery({
    queryKey: ['catalog', 'collections'],
    queryFn: ({ signal }) => api.get<{ collections: CollectionDto[] }>('/collections', signal),
    select: (d) => d.collections,
    staleTime: 60_000,
  });
}

export function useCategories() {
  return useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: ({ signal }) => api.get<{ categories: CategoryNodeDto[] }>('/categories', signal),
    select: (d) => d.categories,
    staleTime: 5 * 60_000,
  });
}

export function useDeliveryEstimate(pincode: string | null) {
  return useQuery({
    queryKey: ['delivery', pincode],
    queryFn: ({ signal }) => api.get<DeliveryEstimateDto>(`/delivery/estimate?pincode=${pincode}`, signal),
    enabled: Boolean(pincode && /^\d{6}$/.test(pincode)),
    staleTime: 10 * 60_000,
  });
}
