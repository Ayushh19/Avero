import { createHash } from 'node:crypto';
import { resolveColor } from '@avero/shared';
import { business } from '../../../config/business';
import type { SourceItem } from './source';

export type Gender = 'men' | 'women' | 'unisex';
export type Activity = 'running' | 'training' | 'sneakers' | 'casual' | 'lifestyle';

export const ACTIVITY_LABELS: Record<Activity, string> = {
  running: 'Running',
  training: 'Training',
  sneakers: 'Sneakers',
  casual: 'Casual',
  lifestyle: 'Lifestyle',
};

export const GENDER_LABELS: Record<Gender, string> = { men: 'Men', women: 'Women', unisex: 'Unisex' };

export interface NormalizedImage {
  externalId: string;
  sourceUrl: string;
  sourceThumbUrl: string | null;
  title: string;
  alt: string;
  position: number;
}

export interface NormalizedSku {
  skuCode: string;
  sizeLabel: string;
  sizeSort: number;
  initialStock: number;
}

export interface NormalizedColorway {
  externalId: string;
  slug: string;
  name: string;
  colorFamily: string;
  hex: string;
  /** Only colours with imagery are published. */
  hasImagery: boolean;
  images: NormalizedImage[];
  skus: NormalizedSku[];
}

export interface NormalizedProduct {
  externalId: string;
  slug: string;
  name: string;
  shortDescription: string;
  description: string;
  highlights: string[];
  tags: string[];
  gender: Gender;
  activity: Activity;
  categoryPath: string;
  pricePaise: number;
  gstRateBps: number;
  colorways: NormalizedColorway[];
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/(^|[\s/&-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

export function inferGender(item: SourceItem): Gender {
  const slugs = item.categories.map((c) => c.slug);
  if (slugs.includes('womens-fashion')) return 'women';
  if (slugs.includes('mens-fashion')) return 'men';
  const text = `${item.product_data.product_title} ${(item.product_data.tags ?? []).join(' ')}`.toLowerCase();
  // Check "women" first: "women's" contains "men's".
  if (/\bwom[ae]n'?s?\b|\bladies\b/.test(text)) return 'women';
  if (/\bm[ae]n'?s?\b/.test(text)) return 'men';
  return 'unisex';
}

export function inferActivity(item: SourceItem): Activity {
  const text = `${item.product_data.product_title} ${(item.product_data.tags ?? []).join(' ')}`.toLowerCase();
  if (/\brun(ning|ner|ners)?\b/.test(text)) return 'running';
  if (/\b(training|trainer|fitness|gym|workout)\b/.test(text)) return 'training';
  if (/\bsneakers?\b/.test(text)) return 'sneakers';
  if (/\b(casual|canvas|everyday)\b/.test(text)) return 'casual';
  return 'lifestyle';
}

/** USD → INR rounded up to the next ₹100, minus ₹1 ($65 → ₹5,399). */
export function convertPrice(usd: string | number): number {
  const value = typeof usd === 'number' ? usd : Number.parseFloat(usd.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid source price: ${usd}`);
  const rupees = Math.ceil((value * business.usdToInr) / 100) * 100 - 1;
  return rupees * 100;
}

export function gstRateFor(pricePaise: number): number {
  return pricePaise <= business.gst.thresholdPaise ? business.gst.lowRateBps : business.gst.highRateBps;
}

function hashOf(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Deterministic starting stock so re-imports and tests are stable:
 * ~10% sold out, ~20% low (1–4), the rest 8–24.
 */
export function initialStockFor(skuCode: string): number {
  const h = hashOf(skuCode);
  const bucket = h[0]! % 10;
  if (bucket === 0) return 0;
  if (bucket <= 2) return 1 + (h[1]! % 4);
  return 8 + (h[1]! % 17);
}

function colorCode(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, '');
  return (letters.slice(0, 3) || 'CLR').padEnd(3, 'X');
}

export function normalizeItem(item: SourceItem): NormalizedProduct {
  const pd = item.product_data;
  const name = pd.product_title.trim();
  const gender = inferGender(item);
  const activity = inferActivity(item);
  const pricePaise = convertPrice(pd.price);
  const productCode = hashOf(item.id).toString('hex').slice(0, 6).toUpperCase();

  const sizes = [...new Set((pd.options?.Size ?? []).map((s) => String(s).trim()).filter(Boolean))]
    .map((label) => ({ label, sort: Math.round(Number.parseFloat(label) * 10) }))
    .filter((s) => Number.isFinite(s.sort))
    .sort((a, b) => a.sort - b.sort);

  const colorNames = [...new Set((pd.options?.Color ?? []).map(titleCase).filter(Boolean))];
  if (colorNames.length === 0) colorNames.push('Default');

  const images = [...item.images]
    .sort((a, b) => a.index - b.index)
    .map<NormalizedImage>((img, i) => ({
      externalId: img.id,
      sourceUrl: img.image_url,
      sourceThumbUrl: img.thumbnail_url ?? null,
      title: img.title?.trim() || `View ${i + 1}`,
      alt: `${name} — ${img.title?.trim().toLowerCase() || `view ${i + 1}`}`,
      position: i,
    }));

  const colorways = colorNames.map<NormalizedColorway>((colorName, index) => {
    const { family, hex } = resolveColor(colorName);
    const code = colorCode(colorName);
    const hasImagery = index === 0 && images.length > 0;
    return {
      externalId: `${item.id}:${slugify(colorName)}`,
      slug: slugify(colorName),
      name: colorName,
      colorFamily: family,
      hex,
      hasImagery,
      images: hasImagery ? images : [],
      skus: sizes.map((s) => {
        const skuCode = `AV-${productCode}-${code}-${s.label.replace('.', 'H')}`;
        return { skuCode, sizeLabel: s.label, sizeSort: s.sort, initialStock: initialStockFor(skuCode) };
      }),
    };
  });

  return {
    externalId: item.id,
    slug: slugify(name),
    name,
    shortDescription: pd.short_description?.trim() ?? '',
    description: pd.long_description?.trim() ?? pd.short_description?.trim() ?? '',
    highlights: (pd.bullet_points ?? []).map((b) => b.trim()).filter(Boolean),
    tags: [...new Set((pd.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))],
    gender,
    activity,
    categoryPath: `${gender}/${activity}`,
    pricePaise,
    gstRateBps: gstRateFor(pricePaise),
    colorways,
  };
}

/** Text indexed for search: everything a shopper might type about this colourway. */
export function buildSearchDocument(p: NormalizedProduct, c: NormalizedColorway): string {
  const genderWords = p.gender === 'men' ? "men mens men's" : p.gender === 'women' ? "women womens women's" : 'unisex';
  return [p.name, c.name, c.colorFamily, genderWords, ACTIVITY_LABELS[p.activity], p.tags.join(' '), p.shortDescription]
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function isImportable(item: SourceItem): boolean {
  return item.state === 'completed' && (item.visibility ?? 'public') === 'public';
}
