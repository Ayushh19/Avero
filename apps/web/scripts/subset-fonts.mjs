// Builds the tiny ₹-only font files in src/styles/fonts. The rupee sign lives in the latin-ext
// subset (85 KB for Inter), so we ship just that glyph instead. Run after upgrading the fonts:
//   pnpm --filter @avero/web fonts:subset
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import subsetFont from 'subset-font';

const require = createRequire(import.meta.url);

for (const family of ['inter', 'manrope']) {
  const source = require.resolve(`@fontsource-variable/${family}/files/${family}-latin-ext-wght-normal.woff2`);
  const out = await subsetFont(await readFile(source), '₹', { targetFormat: 'woff2' });
  const target = new URL(`../src/styles/fonts/${family}-rupee-wght.woff2`, import.meta.url);
  await writeFile(target, out);
  console.log(`${family}: ${out.length} bytes`);
}
