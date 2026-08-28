import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: {
    target: 'esnext',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
  },
  // .glsl / .wgsl are imported with ?raw
  assetsInclude: ['**/*.glsl', '**/*.wgsl'],
});
