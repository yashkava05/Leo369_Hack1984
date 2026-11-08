import { useJob } from '../state/useJob'
import { summarizeJob } from './privacy.format'
import './privacy.css'

// Post-job proof card. Reads the finished job from useJob() and shows exactly what left the
// device: request/byte counts (blocked attempts excluded) and every query string verbatim.
export function LeftDeviceSummary() {
  const { status, result } = useJob()
  if (status !== 'done' || !result) return null

  const summary = summarizeJob(result)

  return (
    <section className="left-device" aria-label="What left this device">
      <p className="left-device-headline">{summary.headline}</p>
      {summary.queries.length > 0 ? (
        <ul className="left-device-queries">
          {summary.queries.map((text, i) => (
            <li key={i}>
              <code>{text}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="left-device-none">No queries left this device.</p>
      )}
    </section>
  )
}
