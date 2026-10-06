/**
 * Source image titles are free text ("Running in Nature", "Lifestyle Scene in a Cafe", …).
 * Merchandising picks images by role instead of exact title.
 */
export type ImageRole = 'studio' | 'side' | 'closeup' | 'flatlay' | 'action' | 'lifestyle' | 'other';

const RULES: [ImageRole, RegExp][] = [
  ['studio', /studio/i],
  ['side', /side profile|side view|alternate angle/i],
  ['closeup', /close-?up|texture|detail/i],
  ['flatlay', /flat ?lay/i],
  ['action', /action|in-use|running/i],
  ['lifestyle', /lifestyle|caf[eé]|urban|nature|setting|aspiration|premium|daily use|context/i],
];

export function imageRole(title: string | null | undefined): ImageRole {
  if (!title) return 'other';
  return RULES.find(([, re]) => re.test(title))?.[0] ?? 'other';
}

/** The `nth` image with a role (in display order), falling back to the first image. */
export function pickImage<T extends { title: string | null }>(images: T[], role: ImageRole, nth = 0): T | undefined {
  return images.filter((i) => imageRole(i.title) === role)[nth] ?? images[0];
}
