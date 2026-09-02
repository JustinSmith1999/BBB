import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Build timestamp baked into the bundle — lets error reports say exactly
  // which deploy a visitor is running.
  define: {
    __BUILD_TS__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // 2026-08-31 STALE-CHUNK FIX: one JS file, no lazy chunks.
        //
        // Every deploy deletes the previous hashed chunk files. Visitors with
        // the site already open (blast traffic!) would tap a route, request a
        // chunk that no longer exists, and hit the ChunkErrorBoundary error
        // screen ("refresh issues"). With everything inlined into a single
        // bundle, an open tab is fully self-contained: it never fetches
        // another JS file, so a deploy can never break it. New visitors get
        // the new bundle. Cost: one larger initial download (~200KB gzip),
        // fully cached after first load. Worth it — checkout traffic must
        // never see an error screen because we shipped a copy tweak.
        inlineDynamicImports: true,
      },
    },
  },
});
