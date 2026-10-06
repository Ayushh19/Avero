// Kept free of zod so pages that only need the labels don't pull in the schema library.
export const SORT_OPTIONS = ['featured', 'newest', 'price_asc', 'price_desc', 'bestselling', 'top_rated', 'relevance'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export const SORT_LABELS: Record<SortOption, string> = {
  featured: 'Featured',
  relevance: 'Most relevant',
  newest: 'Newest',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  bestselling: 'Best selling',
  top_rated: 'Top rated',
};
