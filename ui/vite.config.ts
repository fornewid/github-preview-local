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
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: tauri.app.security.csp }, injectTo: 'head-prepend' as const },
    { tag: 'meta', attrs: { 'http-equiv': 'x-dns-prefetch-control', content: 'off' }, injectTo: 'head-prepend' as const },
    { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' as const },
  ],
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
