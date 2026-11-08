import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Read VITE_* variables from the repo-root .env shared with the backend.
  envDir: '..',
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin API in dev: uploads and the SSE event stream go through this proxy, so the
    // browser never makes a cross-origin request. LATENT_BACKEND_URL overrides the target.
    proxy: {
      '/api': {
        target: process.env.LATENT_BACKEND_URL ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
