import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Read VITE_* variables from the repo-root .env shared with the backend.
  envDir: '..',
  server: { port: 5173, strictPort: true },
})
