import { useJob } from '../state/useJob'
import type { Stage, StageEvent } from '../types'
import './StageStrip.css'

const PIPELINE_STAGES = ['ingest', 'extract', 'scrub', 'query', 'search', 'cards'] as const
type PipelineStage = (typeof PIPELINE_STAGES)[number]
type StepState = 'future' | 'current' | 'complete' | 'failed'

const STATE_LABEL: Record<StepState, string> = {
  future: 'waiting',
  current: 'running',
  complete: 'done',
  failed: 'failed',
}

function stepState(stage: PipelineStage, events: StageEvent[], currentStage: Stage | undefined, failed: boolean): StepState {
  const mine = events.filter((e) => e.stage === stage)
  if (mine.some((e) => e.status === 'error')) return 'failed'
  if (stage === currentStage) {
    if (failed) return 'failed'
    return mine.some((e) => e.status === 'ok') ? 'complete' : 'current'
  }
  if (mine.length > 0) return 'complete' // a later stage has started, so this one finished
  return 'future'
}

export function StageStrip() {
  const { status, events, currentStage } = useJob()
  if (status === 'idle') return null
  const failed = status === 'error'

  const steps = PIPELINE_STAGES.map((stage) => {
    // The badge comes from the stage's own events: true = on device, false = network.
    const local = events.findLast((e) => e.stage === stage)?.local
    return { stage, local, state: stepState(stage, events, currentStage, failed) }
  })

  const current = steps.find((s) => s.state === 'current')
  const announcement =
    status === 'uploading'
      ? 'Uploading screenshot'
      : status === 'done'
        ? 'All stages complete'
        : status === 'error'
          ? 'Pipeline failed'
          : current
            ? `Stage ${current.stage}${current.local === false ? ', on the network' : current.local ? ', on this device' : ''}`
            : ''

  return (
    <div className="stage-strip-wrap">
      <ol className="stage-strip" aria-label="Pipeline stages">
        {steps.map(({ stage, local, state }) => (
          <li key={stage} className={`stage stage-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="stage-mark" aria-hidden="true">
              {state === 'complete' ? '✓' : state === 'failed' ? '✕' : ''}
            </span>
            <span className="stage-name">{stage}</span>
            {local !== undefined && (
              <span className={`stage-badge ${local ? 'badge-local' : 'badge-net'}`}>{local ? 'LOCAL' : 'NET'}</span>
            )}
            <span className="visually-hidden">{STATE_LABEL[state]}</span>
          </li>
        ))}
      </ol>
      <p className="visually-hidden" aria-live="polite" data-testid="stage-announcer">
        {announcement}
      </p>
    </div>
  )
}
