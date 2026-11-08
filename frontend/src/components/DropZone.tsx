import { useCallback, useEffect, useRef, useState } from 'react'
import { useJob } from '../state/useJob'
import { ACCEPTED_TYPES, validateImage } from './validateImage'
import './DropZone.css'

/** `disabledReason` (from the health banners) blocks new drops, e.g. while the local model is down. */
export function DropZone({ disabledReason = null }: { disabledReason?: string | null } = {}) {
  const { status, previewUrl, error, start, reset } = useJob()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [rejection, setRejection] = useState<string | null>(null)
  const busy = status === 'uploading' || status === 'running'
  const finished = status === 'done' || status === 'error'
  const unavailable = disabledReason !== null

  const accept = useCallback(
    (file: File | undefined) => {
      if (!file || busy || unavailable) return
      const problem = validateImage(file)
      setRejection(problem)
      if (!problem) void start(file)
    },
    [busy, unavailable, start],
  )

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = e.clipboardData?.files[0]
      if (!file) return
      e.preventDefault()
      accept(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [accept])

  const again = () => {
    setRejection(null)
    reset()
  }

  return (
    <section className="dropzone-wrap" aria-label="Screenshot input">
      <button
        type="button"
        className={`dropzone${dragging ? ' dragging' : ''}${busy ? ' busy' : ''}`}
        aria-disabled={busy || finished || unavailable}
        aria-describedby="dropzone-hint"
        onClick={() => !busy && !finished && !unavailable && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy && !finished && !unavailable) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (!finished) accept(e.dataTransfer.files[0])
        }}
      >
        {previewUrl ? (
          <img className="dropzone-preview" src={previewUrl} alt="Screenshot being analyzed" />
        ) : (
          <span className="dropzone-prompt">
            <strong>Drop a screenshot</strong>
            <span>{unavailable ? disabledReason : 'or click to choose one, or paste with Ctrl/Cmd+V'}</span>
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        hidden
        onChange={(e) => {
          accept(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <p id="dropzone-hint" className="dropzone-hint">
        PNG, JPEG or WebP up to 10 MB. The image stays on this device.
      </p>
      {rejection && (
        <p role="alert" className="dropzone-error">
          {rejection}
        </p>
      )}
      {status === 'error' && error && (
        <p role="alert" className="dropzone-error">
          {error}
        </p>
      )}
      {finished && (
        <button type="button" className="dropzone-again" onClick={again}>
          Drop another
        </button>
      )}
    </section>
  )
}
