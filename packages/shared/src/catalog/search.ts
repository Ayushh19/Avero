import type { SearchInterpretation } from '../schemas/catalog';
import { COLOR_FAMILIES } from './colors';

const GENDER_WORDS: Record<string, string> = {
  men: 'men', mens: 'men', "men's": 'men', man: 'men', male: 'men', gents: 'men',
  women: 'women', womens: 'women', "women's": 'women', woman: 'women', ladies: 'women', female: 'women',
};

const ACTIVITY_WORDS: Record<string, string> = {
  running: 'running', run: 'running', runner: 'running', runners: 'running', jogging: 'running',
  training: 'training', train: 'training', gym: 'training', fitness: 'training', workout: 'training',
  sneakers: 'sneakers', sneaker: 'sneakers', trainers: 'sneakers', kicks: 'sneakers',
  casual: 'casual', canvas: 'casual', everyday: 'casual',
  lifestyle: 'lifestyle',
};

const COLOR_WORDS: Record<string, string> = Object.fromEntries(
  COLOR_FAMILIES.flatMap((c) => c.words.filter((w) => !w.includes(' ')).map((w) => [w, c.family])),
);

const STOPWORDS = new Set([
  'shoe', 'shoes', 'footwear', 'pair', 'pairs', 'for', 'the', 'a', 'an', 'in', 'with', 'and', 'of', 'to',
  'size', 'rs', 'inr', 'colour', 'color', 'colored', 'coloured', 'buy', 'best', 'new',
]);

function amount(raw: string): number {
  const k = /k$/i.test(raw);
  const n = Number.parseFloat(raw.replace(/[,k]/gi, ''));
  return Math.round(k ? n * 1000 : n);
}

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?k?)`;

/**
 * Understands natural shopping queries: "black sneakers", "shoes under ₹5000",
 * "grey size 9", "women's running between 3k and 7k". Recognised terms become filters;
 * whatever is left is matched as free text (typo tolerant, in the DB).
 */
export function parseSearchQuery(query: string): SearchInterpretation {
  let s = ` ${query.toLowerCase().replace(/[₹]/g, ' ').replace(/\brs\.?\s*/g, ' ').replace(/\s+/g, ' ')} `;
  const out: SearchInterpretation = { query: query.trim(), text: '', gender: [], activity: [], color: [], size: [] };

  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = s.match(re);
    if (m) {
      fn(m);
      s = s.replace(m[0], ' ');
    }
  };

  take(new RegExp(String.raw`\b(?:between|from)\s+${NUM}\s*(?:and|to|-)\s*${NUM}`), (m) => {
    const a = amount(m[1]!);
    const b = amount(m[2]!);
    out.priceMin = Math.min(a, b);
    out.priceMax = Math.max(a, b);
  });
  take(new RegExp(String.raw`(?:\b(?:under|below|less than|upto|up to|within|max)|<)\s*${NUM}`), (m) => {
    out.priceMax = amount(m[1]!);
  });
  take(new RegExp(String.raw`(?:\b(?:over|above|more than|min)|>)\s*${NUM}`), (m) => {
    out.priceMin = amount(m[1]!);
  });
  // "size 9", "uk 8.5", "size uk 7"
  for (;;) {
    const before = s;
    take(/\b(?:size|sz|uk)\s+(?:uk\s+)?(\d{1,2}(?:\.5)?)\b/, (m) => out.size.push(m[1]!));
    if (s === before) break;
  }

  const rest: string[] = [];
  for (const raw of s.split(/[^a-z0-9'.-]+/)) {
    const token = raw.replace(/^['.-]+|['.-]+$/g, '');
    if (!token) continue;
    const g = GENDER_WORDS[token];
    const a = ACTIVITY_WORDS[token];
    const c = COLOR_WORDS[token];
    const add = (list: string[], v: string) => {
      if (!list.includes(v)) list.push(v);
    };
    if (g) add(out.gender, g);
    else if (a) add(out.activity, a);
    else if (c) add(out.color, c);
    else if (!STOPWORDS.has(token)) rest.push(token);
  }
  out.text = rest.join(' ');
  return out;
}

export function isEmptyInterpretation(i: SearchInterpretation): boolean {
  return (
    !i.text &&
    !i.gender.length &&
    !i.activity.length &&
    !i.color.length &&
    !i.size.length &&
    i.priceMin === undefined &&
    i.priceMax === undefined
  );
}

/** Query completions offered while typing (before any trending data exists). */
export const SUGGESTED_QUERIES = [
  'running shoes',
  "women's running shoes",
  "men's sneakers",
  'white sneakers',
  'grey sneakers',
  'training shoes',
  'canvas shoes',
  'shoes under ₹6000',
];

/**
 * Turns a typed query into explicit listing parameters: recognised terms become filters and only
 * the remaining free text stays in `q`. `qraw` keeps what the shopper typed, for display.
 */
export function searchParamsFor(query: string): URLSearchParams {
  const i = parseSearchQuery(query);
  const p = new URLSearchParams();
  p.set('qraw', query.trim());
  if (i.text) p.set('q', i.text);
  if (i.gender.length) p.set('gender', i.gender.join(','));
  if (i.activity.length) p.set('activity', i.activity.join(','));
  if (i.color.length) p.set('color', i.color.join(','));
  if (i.size.length) p.set('size', i.size.join(','));
  if (i.priceMin !== undefined) p.set('priceMin', String(i.priceMin));
  if (i.priceMax !== undefined) p.set('priceMax', String(i.priceMax));
  return p;
}
