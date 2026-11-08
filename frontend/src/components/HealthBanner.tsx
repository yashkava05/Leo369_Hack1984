import type { Banner } from '../state/useHealth'
import './HealthBanner.css'

// Banners derived from GET /api/health: errors (model or backend down) first, then warnings
// (no Tavily key). Renders nothing when everything is healthy.
export function HealthBanner({ banners }: { banners: Banner[] }) {
  if (banners.length === 0) return null
  return (
    <div className="health-banners">
      {banners.map((banner) => (
        <p
          key={banner.id}
          className={`health-banner health-banner--${banner.level}`}
          role={banner.level === 'error' ? 'alert' : 'status'}
          data-testid={`health-banner-${banner.id}`}
        >
          {banner.text}
        </p>
      ))}
    </div>
  )
}
