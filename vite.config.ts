import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Build from project root, output to dist-ui
  root: '.',
  build: {
    outDir: 'dist-ui',
    emptyOutDir: true,
    rollupOptions: {
      input: './index.html'
    }
  },
  server: {
    port: 3000,
    proxy: {
      '/v1': {
        target: process.env.OPENCODE_ENDPOINT || 'http://127.0.0.1:9001',
        changeOrigin: true,
        secure: false
      }
    }
  }
});
