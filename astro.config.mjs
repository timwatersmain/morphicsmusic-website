import { defineConfig } from 'astro/config';
import compressor from 'astro-compressor';

export default defineConfig({
  output: 'static',
  prefetch: {
    defaultStrategy: 'hover',
    prefetchAll: true,
  },
  vite: {
    build: {
      rollupOptions: {
        treeshake: {
          preset: 'smallest',
        },
      },
    },
  },
  integrations: [
    compressor({ gzip: true, brotli: true }), // must be last
  ],
});
