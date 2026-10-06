import type { ImageDto } from '@avero/shared';

/** 400 / 640 / 1024px candidates for `srcset` (the browser picks by `sizes` and pixel density). */
export function imageSrcSet(img: ImageDto): string | undefined {
  const candidates = [
    img.thumbUrl ? `${img.thumbUrl} 400w` : null,
    img.mediumUrl ? `${img.mediumUrl} 640w` : null,
    img.thumbUrl || img.mediumUrl ? `${img.url} 1024w` : null,
  ].filter(Boolean);
  return candidates.length ? candidates.join(', ') : undefined;
}

/** A small single-size image (order lines, return items, review targets). */
export const singleImage = (url: string | null | undefined, alt = ''): ImageDto | null =>
  url ? { url, thumbUrl: null, mediumUrl: null, alt } : null;
