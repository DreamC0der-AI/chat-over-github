import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The production build goes straight into the Worker's static assets folder.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    ...(mode === 'mock' ? {} : { outDir: '../worker/public', emptyOutDir: true }),
  },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
}));
