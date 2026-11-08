import { useEffect, useState } from 'react'
import { getOffline, setOffline } from '../api/privacy'
import './privacy.css'

// Air-gap switch for the header. Reads the runtime offline flag from GET /api/offline on
// load (so the state survives a reload) and POSTs every change back. When on, a persistent
// red pill makes it unmistakable that nothing can leave the device.
export function AirGapToggle() {
  const [offline, setOfflineState] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    getOffline()
      .then((value) => {
        if (active) setOfflineState(value)
      })
      .catch(() => {
        /* backend not reachable yet; leave the switch off */
      })
    return () => {
      active = false
    }
  }, [])

  const toggle = async () => {
    const next = !offline
    setBusy(true)
    setOfflineState(next) // optimistic; reconciled with the server's answer below
    try {
      const confirmed = await setOffline(next)
      setOfflineState(confirmed)
    } catch {
      setOfflineState(!next) // revert on failure
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="airgap">
      <label className="airgap-switch">
        <input
          type="checkbox"
          checked={offline}
          disabled={busy}
          onChange={toggle}
          aria-label="Air-gap mode"
        />
        <span className="airgap-slider" aria-hidden="true" />
        <span className="airgap-label">Air-gap mode</span>
      </label>
      {offline && (
        <span className="airgap-pill" role="status">
          Offline — nothing can leave this device
        </span>
      )}
    </div>
  )
}
