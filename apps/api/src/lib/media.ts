import { access, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq, isNull, like, notLike, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import sharp from 'sharp';
import type { AppContext } from '../context';
import { colorwayImages } from '../db/schema';

/**
 * Responsive image sizes made from each 1024px original: 400px (thumbnails, small cards) and 640px
 * (phones at 2× DPR, desktop grid cards). We make our own 400px rather than using the source's
 * thumbnails, which are compressed less and come out larger than our 640px.
 */
export const THUMB_WIDTH = 400;
export const MEDIUM_WIDTH = 640;

const variantUrl = (url: string, width: number) => url.replace(/\.webp$/, `-${width}.webp`);
export const thumbUrlFor = (url: string) => variantUrl(url, THUMB_WIDTH);
export const mediumUrlFor = (url: string) => variantUrl(url, MEDIUM_WIDTH);

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Writes the 400px and 640px variants beside the original (atomically; each skipped if already there). */
export async function writeImageVariants(originalPath: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(originalPath).metadata();
  for (const width of [THUMB_WIDTH, MEDIUM_WIDTH]) {
    const target = variantUrl(originalPath, width);
    if (await exists(target)) continue;
    const bytes = await sharp(originalPath).resize({ width, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    const tmp = `${target}.part`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }
  return { width: meta.width, height: meta.height };
}

/**
 * Gives images imported before these sizes existed their variants and true dimensions. Runs in
 * the background after start-up (the API owns the single PGlite connection, so this can't be a
 * separate command); a no-op once everything is done. Unreadable files are skipped and retried
 * next start.
 */
export async function backfillImageVariants(ctx: AppContext, log: FastifyBaseLogger): Promise<number> {
  const root = resolve(ctx.env.MEDIA_DIR);
  const rows = await ctx.db
    .select({ id: colorwayImages.id, url: colorwayImages.url })
    .from(colorwayImages)
    .where(
      and(
        like(colorwayImages.url, '/media/%'),
        or(isNull(colorwayImages.mediumUrl), isNull(colorwayImages.thumbUrl), notLike(colorwayImages.thumbUrl, `%-${THUMB_WIDTH}.webp`)),
      ),
    );
  let done = 0;
  for (const row of rows) {
    try {
      const size = await writeImageVariants(join(root, row.url.slice('/media/'.length)));
      await ctx.db
        .update(colorwayImages)
        .set({ thumbUrl: thumbUrlFor(row.url), mediumUrl: mediumUrlFor(row.url), ...size })
        .where(eq(colorwayImages.id, row.id));
      done++;
    } catch (err) {
      log.debug({ err, url: row.url }, 'image variant skipped');
    }
  }
  if (done > 0) {
    ctx.catalog.invalidate();
    log.info({ images: done }, 'made 400/640px image variants');
  }
  return done;
}
