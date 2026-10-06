import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type Rollup } from 'vite';

// Same-origin API in dev so the session cookie is first-party. AVERO_API_URL points the proxy at
// another API (the end-to-end suite runs its own in-memory one).
const api = process.env.AVERO_API_URL ?? 'http://localhost:3000';

/** Preloads the latin body and display fonts so text doesn't wait for the CSS to discover them. */
function fontPreload(): Plugin {
  return {
    name: 'avero-font-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const fonts = Object.keys(ctx.bundle ?? {}).filter((f) => /(inter|manrope)-latin-wght-normal-.*\.woff2$/.test(f));
        return fonts.map((href) => ({ tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${href}`, crossorigin: '' }, injectTo: 'head' }));
      },
    },
  };
}

/**
 * Pages are lazy route chunks, so a cold visit straight to one would fetch the entry bundle before
 * discovering the page's code. For the pages people land on from outside (product, listing), an
 * inline script preloads the matching chunk, its imports and CSS in parallel with the entry.
 */
const LANDING_ROUTES: [pattern: string, module: string][] = [
  ['^/p/', 'features/catalog/ProductPage.tsx'],
  ['^/(c/|collections/.|search)', 'features/catalog/ListingPage.tsx'],
];

function landingPreload(): Plugin {
  return {
    name: 'avero-landing-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle ?? {};
        const chunks = Object.values(bundle).filter((c): c is Rollup.OutputChunk => c.type === 'chunk');
        const entry = chunks.find((c) => c.isEntry);
        const inEntry = new Set([entry?.fileName, ...(entry?.imports ?? [])]);
        const filesFor = (chunk: Rollup.OutputChunk) => {
          const seen = new Set<string>();
          const visit = (name: string) => {
            if (seen.has(name) || inEntry.has(name)) return;
            seen.add(name);
            const c = bundle[name];
            if (c?.type !== 'chunk') return;
            c.imports.forEach(visit);
            c.viteMetadata?.importedCss.forEach((css) => seen.add(css));
          };
          visit(chunk.fileName);
          return [...seen].map((f) => `/${f}`);
        };
        const routes = LANDING_ROUTES.flatMap(([pattern, module]) => {
          const chunk = chunks.find((c) => c.facadeModuleId?.endsWith(module));
          return chunk ? [[pattern, filesFor(chunk)]] : [];
        });
        if (!routes.length) return [];
        const script = `(function(r){for(var i=0;i<r.length;i++)if(new RegExp(r[i][0]).test(location.pathname)){r[i][1].forEach(function(h){var l=document.createElement('link');var css=/\\.css$/.test(h);l.rel=css?'stylesheet':'modulepreload';l.href=h;l.crossOrigin='';document.head.appendChild(l)});return}})(${JSON.stringify(routes)})`;
        return [{ tag: 'script', children: script, injectTo: 'head-prepend' }];
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), fontPreload(), landingPreload()],
  server: {
    port: 5173,
    proxy: { '/api': api, '/media': api },
  },
});
