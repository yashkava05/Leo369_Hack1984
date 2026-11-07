import { Check, Copy, Download, ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Card, CardAction } from '../../types'
import { runAction } from './cardActions'

const FEEDBACK_MS = 1500

const ICONS = { open_url: ExternalLink, download_ics: Download, copy: Copy } as const

export function ActionButton({ action, card, primary }: { action: CardAction; card: Card; primary: boolean }) {
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const flash = (state: 'copied' | 'failed') => {
    setFeedback(state)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS)
  }

  const onClick = () => {
    runAction(action, card).then(
      () => action.type === 'copy' && flash('copied'),
      (err: unknown) => {
        console.error(`Card action "${action.label}" failed`, err)
        flash('failed')
      },
    )
  }

  const Icon = feedback === 'copied' ? Check : ICONS[action.type]
  const text = feedback === 'copied' ? 'Copied' : feedback === 'failed' ? 'Failed' : action.label
  const hint = action.type === 'open_url' ? ' (opens in a new tab)' : ''

  return (
    <button
      type="button"
      className={`card-action${primary ? ' card-action--primary' : ''}`}
      onClick={onClick}
      aria-label={`${action.label}${hint}: ${card.title}`}
      data-action={action.type}
    >
      <Icon size={16} aria-hidden="true" />
      <span aria-live="polite">{text}</span>
    </button>
  )
}
