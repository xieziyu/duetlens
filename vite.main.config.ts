import { defineConfig } from 'vite';
import path from 'node:path';

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      '@backend': path.resolve(__dirname, 'src/backend'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
