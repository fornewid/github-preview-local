import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Everything (JS, CSS, fonts, the highlighter worker and its WASM) is inlined
// into a single index.html. The native window loads it through Tauri's custom
// protocol and `prv export` writes it to disk, so no web server is involved.
export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
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
