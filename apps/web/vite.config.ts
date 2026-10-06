import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Same-origin API in dev so the session cookie is first-party. AVERO_API_URL points the proxy at
// another API (the end-to-end suite runs its own in-memory one).
const api = process.env.AVERO_API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': api, '/media': api },
  },
});
