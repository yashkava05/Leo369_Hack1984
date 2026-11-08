/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_MOCK?: string
  readonly VITE_LATENT_EXTENSION_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
