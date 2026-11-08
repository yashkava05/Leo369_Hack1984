import { Aperture, MessageCircle, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import { useLayoutEffect } from 'react'
import { Orb, Wordmark } from '../../chat/ChatApp'
import { AppChrome } from '../AppNav'
import { useFeed } from '../../state/useFeed'
import { FeedCard } from './FeedCard'
import { FeedDetail } from './FeedDetail'
import '../../chat/chat.css'
import './feed.css'

export function ForYouPage() {
  const feed = useFeed()

  useLayoutEffect(() => {
    document.body.classList.add('chat-mode')
    return () => document.body.classList.remove('chat-mode')
  }, [])

  return (
    <div className="feed-app">
      <AppChrome
        current="for-you"
        end={
          <button type="button" className="feed-refresh" disabled={feed.refreshing} onClick={() => { void feed.refresh() }}>
            <RefreshCw size={16} className={feed.refreshing ? 'is-spinning' : ''} aria-hidden="true" />
            {feed.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />
      <aside className="chat-sidebar feed-sidebar" aria-label="PrismLocal navigation">
        <div className="chat-brand"><Orb /><Wordmark /></div>
        <nav className="chat-sidebar-section" aria-label="Main">
          <h2>Explore</h2>
          <a className="chat-nav-item" href="/"><Aperture size={17} aria-hidden="true" /><span>Home</span></a>
          <a className="chat-nav-item" href="?view=chat"><MessageCircle size={17} aria-hidden="true" /><span>Chat</span></a>
          <a className="chat-nav-item is-selected" href="?view=for-you" aria-current="page"><Sparkles size={17} aria-hidden="true" /><span>For You</span><span className="chat-online-dot" /></a>
        </nav>
        <div className="feed-sidebar-note">
          <Sparkles size={19} aria-hidden="true" />
          <p>A private edit from the public details in memories you chose to keep.</p>
        </div>
        <div className="chat-sidebar-footer"><ShieldCheck size={17} aria-hidden="true" /><div>Private by design.<span>Every suggestion explains itself.</span></div></div>
      </aside>

      <main className="feed-main">
        <header className="feed-header">
          <div className="feed-heading">
            <p className="feed-kicker">From what you kept</p>
            <h1>For You</h1>
            <p>Notes from screenshots PrismLocal already read on this computer.</p>
          </div>
        </header>

        {feed.error && <div className="feed-error" role="alert"><p>{feed.error}</p><button type="button" onClick={() => { void feed.load() }}>Try again</button></div>}

        {feed.loading ? (
          <div className="feed-loading" role="status" aria-label="Gathering your feed">
            <div /><div /><div />
            <p>Gathering a thoughtful edit…</p>
          </div>
        ) : feed.items.length === 0 ? (
          <section className="feed-empty">
            <Sparkles size={27} aria-hidden="true" />
            <h2>Nothing new just yet</h2>
            <p>Save a few events, places, or ideas in chat. PrismLocal will find the threads between them — still on this computer.</p>
            <a href="?view=chat">Return to chat</a>
          </section>
        ) : (
          <>
            <section className="feed-stream" aria-label="For You feed">
              {feed.items.map((item) => (
                <FeedCard
                  key={item.id}
                  item={item}
                  feedback={feed.feedback[item.id] ?? []}
                  onOpen={() => { void feed.open(item.id) }}
                  onFeedback={(action) => { void feed.respond(item.id, action) }}
                />
              ))}
            </section>
            <footer className="feed-caught-up">
              <span><CheckMark /></span>
              <h2>You’re caught up.</h2>
              <p>No endless scroll. Come back when your memories have something useful to add.</p>
            </footer>
          </>
        )}

        {feed.detailLoading && <div className="feed-detail-loading" role="status">Opening story…</div>}
        {feed.detail && (
          <FeedDetail
            item={feed.detail}
            feedback={feed.feedback[feed.detail.id] ?? []}
            onClose={feed.close}
            onFeedback={(action) => { void feed.respond(feed.detail!.id, action) }}
          />
        )}
      </main>
    </div>
  )
}

function CheckMark() {
  return <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="m4 9 3.2 3.2L14 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
