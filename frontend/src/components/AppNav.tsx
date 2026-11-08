import type { ReactNode } from 'react'
import './appNav.css'

type AppView = 'prism' | 'chat' | 'for-you'

export function AppNav({ current }: { current: AppView }) {
  return (
    <nav className="app-nav" aria-label="Main navigation">
      <a className={`app-nav-link ${current === 'prism' ? 'is-active' : ''}`} href="/" aria-current={current === 'prism' ? 'page' : undefined}>Prism</a>
      <a className={`app-nav-link ${current === 'chat' ? 'is-active' : ''}`} href="?view=chat" aria-current={current === 'chat' ? 'page' : undefined}>Chat</a>
      <a className={`app-nav-link ${current === 'for-you' ? 'is-active' : ''}`} href="?view=for-you" aria-current={current === 'for-you' ? 'page' : undefined}>For You</a>
    </nav>
  )
}

export function AppChrome({ current, end }: { current: AppView; end?: ReactNode }) {
  return (
    <header className="app-chrome">
      <a className="app-chrome-brand" href="/">Prism</a>
      <AppNav current={current} />
      <div className="app-chrome-end">{end}</div>
    </header>
  )
}
