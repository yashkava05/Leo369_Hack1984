import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const root = createRoot(document.getElementById('root')!)

// Dev-only gallery of every action card: /cards or ?gallery=1. The import sits behind
// import.meta.env.DEV so the gallery and its fixture data are dropped from production builds.
const wantsGallery =
  window.location.pathname === '/cards' || new URLSearchParams(window.location.search).has('gallery')

if (import.meta.env.DEV && wantsGallery) {
  void import('./pages/CardGallery.tsx').then(({ CardGallery }) =>
    root.render(
      <StrictMode>
        <CardGallery />
      </StrictMode>,
    ),
  )
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
