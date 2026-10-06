import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin API in dev so the session cookie is first-party.
    proxy: { '/api': 'http://localhost:3000', '/media': 'http://localhost:3000' },
  },
});
