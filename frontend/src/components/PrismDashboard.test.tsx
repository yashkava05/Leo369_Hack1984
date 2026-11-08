import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrismDashboard } from './PrismDashboard'

describe('Prism spatial dashboard', () => {
  it('renders a spatial overlay instead of a chat column', () => {
    const html = renderToStaticMarkup(<PrismDashboard />)
    expect(html).toContain('app-chrome')
    expect(html).toContain('For You')
    expect(html).toContain('Drop a screenshot here, or tap to speak.')
    expect(html).toContain('Tame Impala Concert')
    expect(html).toContain('Sample · Live near you')
    expect(html).toContain('The Bell Jar')
    expect(html).toContain('Air-Gap')
    expect(html).toContain('WEB ENABLED')
    expect(html).not.toContain('chat-bubble')
    expect(html).not.toContain('chat-composer')
    expect(html).not.toContain('<canvas')
  })
})
