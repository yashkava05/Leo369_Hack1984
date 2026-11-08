import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// Browser-session agent (#67): the backend writes a per-launch secret to a 0600 file and only
// accepts /api/browser requests carrying it. This proxy adds it server-side, so it never reaches
// page JavaScript and pages not served through this proxy cannot start or read a mailbox job.
function uiSecretPath(env: Record<string, string | undefined>): string {
  const expand = (path: string) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)
  if (env.LATENT_UI_SECRET_PATH) return expand(env.LATENT_UI_SECRET_PATH)
  if (env.LATENT_DB_PATH) return join(dirname(expand(env.LATENT_DB_PATH)), 'ui-secret')
  return join(homedir(), '.latent', 'ui-secret')
}

function readUiSecret(path: string): string | null {
  try { return readFileSync(path, 'utf8').trim() || null } catch { return null }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, '..', ''), ...process.env }
  const secretPath = uiSecretPath(env)
  return {
    plugins: [react(), tailwindcss()],
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
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              proxyReq.removeHeader('x-latent-ui-secret') // a page can never supply its own
              if (!req.url?.startsWith('/api/browser/')) return
              const secret = readUiSecret(secretPath) // re-read: the backend mints one per launch
              if (secret) proxyReq.setHeader('x-latent-ui-secret', secret)
            })
          },
        },
      },
    },
  }
})
