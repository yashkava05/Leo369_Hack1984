import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { CardGallery } from './pages/CardGallery.tsx'

// Dev gallery of every action card: /cards or ?gallery=1.
const showGallery =
  window.location.pathname === '/cards' || new URLSearchParams(window.location.search).has('gallery')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{showGallery ? <CardGallery /> : <App />}</StrictMode>,
)
