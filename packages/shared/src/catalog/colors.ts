/**
 * Colour vocabulary shared by the importer (colour name → family + swatch) and search
 * (query words → family). Families are what shoppers filter by.
 */
export interface ColorFamily {
  family: string;
  label: string;
  hex: string;
  words: string[];
}

export const COLOR_FAMILIES: ColorFamily[] = [
  { family: 'black', label: 'Black', hex: '#1E1E1E', words: ['black', 'jet', 'onyx', 'charcoal'] },
  { family: 'white', label: 'White', hex: '#F4F3EF', words: ['white', 'ivory', 'off-white', 'offwhite', 'chalk'] },
  { family: 'grey', label: 'Grey', hex: '#A3A5A4', words: ['grey', 'gray', 'ash', 'slate', 'silver'] },
  { family: 'beige', label: 'Beige', hex: '#D8C7AE', words: ['beige', 'cream', 'sand', 'tan', 'khaki', 'natural', 'stone'] },
  { family: 'brown', label: 'Brown', hex: '#7A5A43', words: ['brown', 'chocolate', 'mocha', 'coffee'] },
  { family: 'blue', label: 'Blue', hex: '#3D5A99', words: ['blue', 'navy', 'cobalt', 'indigo', 'denim', 'sky'] },
  { family: 'green', label: 'Green', hex: '#7FBF5A', words: ['green', 'olive', 'sage', 'mint', 'lime', 'fluorescent green', 'neon green'] },
  { family: 'pink', label: 'Pink', hex: '#E9B7BA', words: ['pink', 'rose', 'blush', 'salmon'] },
  { family: 'purple', label: 'Purple', hex: '#6B4FA0', words: ['purple', 'violet', 'lilac', 'lavender', 'mauve'] },
  { family: 'red', label: 'Red', hex: '#B33A3A', words: ['red', 'maroon', 'burgundy', 'crimson'] },
  { family: 'orange', label: 'Orange', hex: '#E07B39', words: ['orange', 'rust', 'coral'] },
  { family: 'yellow', label: 'Yellow', hex: '#E5C04B', words: ['yellow', 'mustard', 'gold'] },
];

const byFamily = new Map(COLOR_FAMILIES.map((c) => [c.family, c]));

export function colorFamilyLabel(family: string): string {
  return byFamily.get(family)?.label ?? family.charAt(0).toUpperCase() + family.slice(1);
}

/** All families mentioned in a colour name, in order of appearance ("Blue & Purple" → blue, purple). */
export function familiesIn(text: string): ColorFamily[] {
  const lower = ` ${text.toLowerCase().replace(/[^a-z\s-]/g, ' ')} `;
  const hits: { family: ColorFamily; at: number }[] = [];
  for (const family of COLOR_FAMILIES) {
    // Longest words first so "fluorescent green" wins over "green".
    for (const word of [...family.words].sort((a, b) => b.length - a.length)) {
      const at = lower.indexOf(` ${word} `);
      if (at >= 0) {
        hits.push({ family, at });
        break;
      }
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.family);
}

function mixHex(a: string, b: string): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round((v + pb[i]!) / 2).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** Resolves a free-text colour name to a filterable family and a swatch colour. */
export function resolveColor(name: string): { family: string; hex: string } {
  const found = familiesIn(name);
  if (found.length === 0) return { family: 'multi', hex: '#B8B2A7' };
  if (found.length === 1) return { family: found[0]!.family, hex: found[0]!.hex };
  return { family: found[0]!.family, hex: mixHex(found[0]!.hex, found[1]!.hex) };
}
