import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WatchPillView } from './WatchPill'

describe('WatchPillView', () => {
  it('shows the watched folder when the watcher is on', () => {
    const html = renderToStaticMarkup(<WatchPillView status={{ enabled: true, dir: '~/Desktop' }} />)
    expect(html).toContain('Watching ~/Desktop')
    expect(html).toContain('role="status"')
  })

  it('renders nothing when the watcher is off or unknown', () => {
    expect(renderToStaticMarkup(<WatchPillView status={{ enabled: false, dir: null }} />)).toBe('')
    expect(renderToStaticMarkup(<WatchPillView status={null} />)).toBe('')
  })
})
