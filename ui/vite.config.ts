import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import tauri from '../src-tauri/tauri.conf.json'

// prv sends nothing anywhere. The page may only use what it carries: no image, font, media or
// request from another host. The native window gets this policy as a header from
// tauri.conf.json; the same policy goes into the page itself for `prv export`, which a browser
// opens without that header. No DNS prefetching of link hosts, no referrer.
const noEgress = {
  name: 'prv-no-egress',
  apply: 'build' as const,
  // Right after <meta charset> (which must stay within the first 1024 bytes), before any script.
  transformIndexHtml: (html: string) => {
    const charset = '<meta charset="UTF-8" />'
    if (!html.includes(charset)) throw new Error('prv-no-egress: <meta charset="UTF-8" /> not found in index.html')
    const csp = tauri.app.security.csp.replace(/'/g, '&#39;')
    return html.replace(
      charset,
      `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${csp}">` +
        '\n    <meta http-equiv="x-dns-prefetch-control" content="off">\n    <meta name="referrer" content="no-referrer">',
    )
  },
}

// Everything (JS, CSS, fonts, the highlighter worker and its WASM) is inlined
// into a single index.html. The native window loads it through Tauri's custom
// protocol and `prv export` writes it to disk, so no web server is involved.
export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true }), noEgress],
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
    cssCodeSplit: false,
    outDir: 'dist',
  },
  worker: { format: 'iife' },
  server: { port: 5173, strictPort: true },
})
