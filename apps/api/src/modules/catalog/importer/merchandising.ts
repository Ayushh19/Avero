import type { CollectionRules } from '../../../db/schema';
import type { ImageRole } from '../images';

/**
 * Store-owned merchandising decisions the source catalog cannot provide.
 * Keyed by product slug so they survive re-imports.
 */

/** Launch discounts: MRP set above the selling price on first import. */
export const LAUNCH_MRP_MARKUP_BPS: Record<string, number> = {
  'womens-pink-training-shoes': 2000, // 20% above price → shown as ~17% off
};

/** Editorial copy for the home page. Images are resolved from the catalog at request time. */
export const HOME_CONTENT = {
  hero: [
    { collection: 'new-arrivals', eyebrow: 'New collection', title: 'Modern comfort for your active life', body: 'Performance-minded. Everyday ready.' },
    { collection: 'running', eyebrow: 'The running edit', title: 'Light on your feet long on the road', body: 'Responsive cushioning for every kilometre.' },
    { collection: 'lifestyle', eyebrow: 'Lifestyle', title: 'Quiet design, made for the city', body: 'Clean lines in easy-to-wear tones.' },
  ],
  tiles: [
    { title: 'Best Sellers', to: '/collections/best-sellers', tone: 'mist', from: { collection: 'best-sellers' } },
    { title: 'New Arrivals', to: '/collections/new-arrivals', tone: 'sage', from: { collection: 'new-arrivals', pick: 1 } },
    { title: 'Men', to: '/c/men', tone: 'sand', from: { category: 'men', pick: 1 }, arch: true },
    { title: 'Women', to: '/c/women', tone: 'mauve', from: { category: 'women' } },
  ],
  /** Rotates on the home page (one slide every few seconds). */
  editorial: [
    {
      eyebrow: 'The AVERO way',
      title: 'Sustainable comfort meets effortless style',
      body: 'Thoughtfully designed footwear for people who move forward — breathable uppers, cushioned soles and a fit that feels right from the first step.',
      to: '/collections/lifestyle',
      cta: 'Explore the collection',
      imageFrom: { product: 'womens-white-low-top-canvas-shoes', role: 'lifestyle', nth: 1 },
      secondaryFrom: { product: 'mens-gray-low-top-sneakers', role: 'closeup', nth: 0 },
    },
    {
      eyebrow: 'Made for motion',
      title: 'Lightweight support for every stride',
      body: 'Responsive foam and grippy outsoles that keep up with morning runs, gym sessions and everything in between.',
      to: '/collections/running',
      cta: 'Shop running',
      imageFrom: { product: 'fluorescent-green-womens-running-shoes', role: 'action', nth: 0 },
      secondaryFrom: { product: 'fluorescent-green-womens-running-shoes', role: 'closeup', nth: 0 },
    },
    {
      eyebrow: 'City ready',
      title: 'Everyday sneakers with a quiet edge',
      body: 'Easy-to-wear colours and clean silhouettes that go from the commute to the weekend without missing a beat.',
      to: '/collections/new-arrivals',
      cta: 'Shop new arrivals',
      imageFrom: { product: 'modern-blue-purple-sneakers', role: 'lifestyle', nth: 0 },
      secondaryFrom: { product: 'womens-pink-training-shoes', role: 'closeup', nth: 0 },
    },
  ],
} as const;

export interface CollectionSeed {
  slug: string;
  name: string;
  description: string;
  kind: 'manual' | 'rule';
  rules?: CollectionRules;
  /** For manual collections: product slugs in display order. */
  productSlugs?: string[];
  /** Product slug whose lifestyle image becomes the collection hero. */
  heroFrom?: string;
  heroImageRole?: ImageRole;
  position: number;
}

export const COLLECTIONS: CollectionSeed[] = [
  {
    slug: 'new-arrivals',
    name: 'New Arrivals',
    description: 'The latest from AVERO — fresh silhouettes and colours for the season ahead.',
    kind: 'rule',
    rules: { launchedWithinDays: 60 },
    heroFrom: 'mens-gray-low-top-sneakers',
    heroImageRole: 'action',
    position: 0,
  },
  {
    slug: 'best-sellers',
    name: 'Best Sellers',
    description: 'The pairs our community keeps coming back for.',
    kind: 'manual',
    productSlugs: ['mens-gray-low-top-sneakers', 'womens-white-low-top-canvas-shoes', 'modern-blue-purple-sneakers'],
    heroFrom: 'mens-gray-low-top-sneakers',
    heroImageRole: 'lifestyle',
    position: 1,
  },
  {
    slug: 'running',
    name: 'The Running Edit',
    description: 'Responsive cushioning and breathable uppers for every kilometre.',
    kind: 'rule',
    rules: { activities: ['running', 'training'] },
    heroFrom: 'fluorescent-green-womens-running-shoes',
    heroImageRole: 'lifestyle',
    position: 2,
  },
  {
    slug: 'lifestyle',
    name: 'Lifestyle',
    description: 'Sustainable comfort meets effortless style — clean designs for everyday wear.',
    kind: 'rule',
    rules: { activities: ['sneakers', 'casual', 'lifestyle'] },
    heroFrom: 'womens-white-low-top-canvas-shoes',
    heroImageRole: 'lifestyle',
    position: 3,
  },
];
