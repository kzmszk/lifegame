import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../public', import.meta.url)),
    emptyOutDir: true,
  },
});
