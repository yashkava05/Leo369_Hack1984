import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, useTexture } from '@react-three/drei'
import { MotionConfig, motion } from 'framer-motion'
import {
  ArrowUpRight,
  BookOpen,
  CalendarPlus,
  Compass,
  ImagePlus,
  LockKeyhole,
  Mic,
  ShieldCheck,
  Sparkles,
  Ticket,
  Upload,
  type LucideIcon,
} from 'lucide-react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { DoubleSide, type Group } from 'three'
import { getOffline, setOffline } from '../api/privacy'
import { reserveVoiceSlot, useJob } from '../state/useJob'
import { detectWebGL2, prefersReducedMotion, REDUCED_MOTION_QUERY } from '../three/capabilities'
import type { Card, Stage } from '../types'
import { AppChrome } from './AppNav'
import { ActionButton } from './cards/ActionButton'
import { cardActions } from './cards/cardActions'
import './cards/cards.css'
import { VoiceCapture } from './voice/VoiceCapture'
import { ACCEPTED_TYPES, validateImage } from './validateImage'

// Local sample stills only — never remote placeholder CDNs. Image bytes stay on this machine.
const GALLERY_IMAGES = [
  '/samples/concert_ig.png',
  '/samples/book_goodreads.png',
  '/samples/product_amazon.png',
  '/samples/doc_internal_email.png',
  '/samples/concert_ig.png',
  '/samples/book_goodreads.png',
] as const

const CARD_SLOTS = [
  'left-[4%] top-[16%] max-[560px]:left-4 max-[560px]:top-[5.5rem]',
  'right-[4%] top-[17%] max-[560px]:right-4 max-[560px]:top-[5.5rem]',
  'left-[7%] bottom-[24%] max-[560px]:left-4 max-[560px]:bottom-[7.5rem]',
  'right-[7%] bottom-[23%] max-[560px]:right-4 max-[560px]:bottom-[7.5rem]',
] as const

const SAMPLE_CARDS: BloomCard[] = [
  {
    id: 'sample-tickets',
    eyebrow: 'Live near you',
    title: 'Tame Impala Concert',
    detail: 'Two verified dates from a festival flyer you already saved.',
    actionLabel: 'Buy tickets',
    icon: Ticket,
    slot: CARD_SLOTS[0],
    tint: 'from-fuchsia-400/25 to-violet-500/5',
  },
  {
    id: 'sample-book',
    eyebrow: 'From your shelf',
    title: 'The Bell Jar',
    detail: 'A quiet edition is waiting at three independent shops.',
    actionLabel: 'View book',
    icon: BookOpen,
    slot: CARD_SLOTS[1],
    tint: 'from-cyan-300/25 to-blue-500/5',
  },
  {
    id: 'sample-place',
    eyebrow: 'Loose thread',
    title: 'A weekend in Lisbon',
    detail: 'Three saved places settle into one unhurried afternoon.',
    actionLabel: 'Open route',
    icon: Compass,
    slot: CARD_SLOTS[2],
    tint: 'from-emerald-300/25 to-teal-500/5',
  },
  {
    id: 'sample-calendar',
    eyebrow: 'Worth remembering',
    title: 'Nova Fields',
    detail: 'You kept the lineup, but the date never made it to a calendar.',
    actionLabel: 'Add to calendar',
    icon: CalendarPlus,
    slot: CARD_SLOTS[3],
    tint: 'from-amber-300/25 to-orange-500/5',
  },
]

const STAGE_COPY: Partial<Record<Stage, string>> = {
  ingest: 'Reading the screenshot on this device',
  extract: 'Extracting intent locally',
  scrub: 'Removing private details',
  query: 'Building public search queries',
  search: 'Searching the web',
  cards: 'Blooming action cards',
  error: 'Something went wrong',
}

const KIND_ICON: Record<Card['kind'], LucideIcon> = {
  tickets: Ticket,
  book: BookOpen,
  calendar: CalendarPlus,
  place: Compass,
  shop: Sparkles,
  insight: Sparkles,
  link: ArrowUpRight,
  related: Sparkles,
}

const KIND_TINT: Record<Card['kind'], string> = {
  tickets: 'from-fuchsia-400/25 to-violet-500/5',
  book: 'from-cyan-300/25 to-blue-500/5',
  calendar: 'from-amber-300/25 to-orange-500/5',
  place: 'from-emerald-300/25 to-teal-500/5',
  shop: 'from-violet-300/25 to-fuchsia-500/5',
  insight: 'from-sky-300/20 to-indigo-500/5',
  link: 'from-white/10 to-transparent',
  related: 'from-teal-300/20 to-cyan-500/5',
}

type BloomCard = {
  id: string
  eyebrow: string
  title: string
  detail: string
  actionLabel: string
  icon: LucideIcon
  slot: string
  tint: string
  source?: Card
}

function useSynthSound() {
  const contextRef = useRef<AudioContext | null>(null)
  const lastPlayed = useRef(0)

  useEffect(() => () => {
    void contextRef.current?.close()
  }, [])

  return useCallback(() => {
    const now = performance.now()
    if (now - lastPlayed.current < 140) return
    lastPlayed.current = now

    const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const context = contextRef.current ?? new AudioCtx()
    contextRef.current = context

    const play = () => {
      const start = context.currentTime
      const oscillator = context.createOscillator()
      const click = context.createOscillator()
      const gain = context.createGain()
      const clickGain = context.createGain()
      const filter = context.createBiquadFilter()

      oscillator.type = 'triangle'
      oscillator.frequency.setValueAtTime(118, start)
      oscillator.frequency.exponentialRampToValueAtTime(52, start + 0.07)
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(420, start)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.06, start + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.08)

      click.type = 'square'
      click.frequency.setValueAtTime(190, start)
      clickGain.gain.setValueAtTime(0.03, start)
      clickGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.018)

      oscillator.connect(filter).connect(gain).connect(context.destination)
      click.connect(clickGain).connect(context.destination)
      oscillator.start(start)
      click.start(start)
      oscillator.stop(start + 0.09)
      click.stop(start + 0.02)
    }

    if (context.state === 'suspended') void context.resume().then(play).catch(() => undefined)
    else play()
  }, [])
}

function galleryPose(index: number, count: number) {
  const angle = (index / count) * Math.PI * 2
  const radius = 6.4
  return {
    x: radius * Math.cos(angle),
    y: Math.sin(angle * 2) * 0.52 + (index % 2 === 0 ? 0.42 : -0.38),
    z: radius * Math.sin(angle),
    rotationY: -angle - Math.PI / 2,
  }
}

function GalleryPlane({ url, index }: { url: string; index: number }) {
  const texture = useTexture(url)
  const group = useRef<Group>(null)
  const pose = galleryPose(index, GALLERY_IMAGES.length)

  useFrame(({ clock }) => {
    if (!group.current) return
    group.current.position.y = pose.y + Math.sin(clock.elapsedTime * 0.4 + index) * 0.14
  })

  return (
    <group ref={group} position={[pose.x, pose.y, pose.z]} rotation={[0, pose.rotationY, 0]}>
      <mesh position={[0, 0, -0.02]}>
        <planeGeometry args={[3.62, 2.42]} />
        <meshBasicMaterial color="#dbe7ff" transparent opacity={0.08} side={DoubleSide} depthWrite={false} />
      </mesh>
      <mesh>
        <planeGeometry args={[3.38, 2.22]} />
        <meshStandardMaterial
          map={texture}
          transparent
          opacity={0.62}
          side={DoubleSide}
          roughness={0.42}
          metalness={0.12}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

function AmbientGallery() {
  return (
    <Canvas
      className="absolute inset-0 -z-10"
      camera={{ position: [0, 0.18, 0.12], fov: 64, near: 0.1, far: 40 }}
      dpr={[1, 1.5]}
      gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
    >
      <color attach="background" args={['#070910']} />
      <fog attach="fog" args={['#070910', 8.5, 16]} />
      <ambientLight intensity={0.42} />
      <pointLight position={[0, 2.6, 0]} intensity={16} distance={18} color="#9bd7ff" />
      <pointLight position={[5, -1.2, -3]} intensity={11} distance={16} color="#8b5cf6" />
      <pointLight position={[-5, 0.8, 4]} intensity={9} distance={16} color="#34d399" />
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -2.35, 0]}>
        <torusGeometry args={[6.4, 0.012, 8, 96]} />
        <meshBasicMaterial color="#d7e7ff" transparent opacity={0.09} />
      </mesh>
      <Suspense fallback={null}>
        {GALLERY_IMAGES.map((url, index) => (
          <GalleryPlane key={`${url}-${index}`} url={url} index={index} />
        ))}
      </Suspense>
      <OrbitControls
        autoRotate
        autoRotateSpeed={0.5}
        rotateSpeed={0.5}
        enablePan={false}
        enableZoom={false}
        enableDamping
        dampingFactor={0.045}
        target={[0, 0.15, 0]}
      />
    </Canvas>
  )
}

function FallbackAura() {
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden bg-[#070910]" aria-hidden="true">
      <div className="absolute left-1/2 top-1/2 h-[720px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(91,95,240,0.22),transparent_62%)]" />
      <div className="absolute left-[12%] top-[18%] h-40 w-56 rotate-[-12deg] rounded-2xl border border-white/10 bg-white/5" />
      <div className="absolute right-[10%] top-[22%] h-44 w-60 rotate-[8deg] rounded-2xl border border-white/10 bg-white/5" />
      <div className="absolute bottom-[22%] left-[18%] h-36 w-52 rotate-[14deg] rounded-2xl border border-white/10 bg-white/5" />
      <div className="absolute bottom-[24%] right-[16%] h-40 w-56 rotate-[-7deg] rounded-2xl border border-white/10 bg-white/5" />
    </div>
  )
}

function HardwareToggle({ sound }: { sound: () => void }) {
  const [offline, setOfflineState] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    getOffline().then((value) => {
      if (active) setOfflineState(value)
    }).catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const toggle = async () => {
    if (busy) return
    sound()
    const next = !offline
    setOfflineState(next)
    setBusy(true)
    try {
      setOfflineState(await setOffline(next))
    } catch {
      setOfflineState(!next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.div
      className="pointer-events-auto flex flex-col items-center"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 0.18, duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
    >
      <p className="mb-2 text-[9px] font-semibold tracking-[0.28em] text-white/40">AIR-GAP</p>
      <button
        type="button"
        role="switch"
        aria-checked={offline}
        aria-label={`Air-Gap: ${offline ? 'Local Only' : 'Web Enabled'}`}
        disabled={busy}
        onClick={() => { void toggle() }}
        className={`relative h-[52px] w-[124px] rounded-[20px] border p-[5px] transition-all duration-500 ${
          offline
            ? 'border-cyan-300/30 bg-emerald-950/50 shadow-[0_0_28px_rgba(45,212,191,0.28),inset_0_2px_4px_rgba(0,0,0,0.5)]'
            : 'border-violet-300/30 bg-violet-950/40 shadow-[0_0_32px_rgba(139,92,246,0.32),inset_0_2px_4px_rgba(0,0,0,0.5)]'
        }`}
      >
        <span className="absolute inset-[5px] rounded-[15px] border border-white/5 bg-black/35 shadow-[inset_0_2px_4px_rgba(0,0,0,0.5)]" />
        <motion.span
          className="absolute top-[7px] grid h-[38px] w-[38px] place-items-center rounded-[13px] border border-white/25 bg-gradient-to-b from-white/30 to-white/5 shadow-[0_8px_14px_rgba(0,0,0,0.45),inset_0_1px_1px_rgba(255,255,255,0.4)]"
          animate={{ x: offline ? 76 : 3 }}
          transition={{ type: 'spring', stiffness: 430, damping: 32 }}
        >
          {offline ? <LockKeyhole size={15} className="text-emerald-200" /> : <Sparkles size={15} className="text-violet-200" />}
        </motion.span>
      </button>
      <div className="mt-3 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/30 px-2.5 py-1 backdrop-blur-md">
        <span className={`h-1.5 w-1.5 rounded-full ${offline ? 'bg-emerald-300 shadow-[0_0_10px_#6ee7b7]' : 'bg-violet-300 shadow-[0_0_10px_#c4b5fd]'}`} />
        <span className="text-[10px] font-medium tracking-[0.14em] text-white/70">{offline ? 'LOCAL ONLY' : 'WEB ENABLED'}</span>
      </div>
    </motion.div>
  )
}

function SpatialCard({ item, index }: { item: BloomCard; index: number }) {
  const Icon = item.icon
  const actions = item.source ? cardActions(item.source) : []

  return (
    <motion.article
      className={`pointer-events-auto absolute w-[min(236px,40vw)] overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-md transition duration-300 hover:border-white/25 hover:bg-white/[0.08] max-[720px]:w-[min(210px,44vw)] max-[720px]:p-3 ${item.slot}`}
      initial={{ opacity: 0, scale: 0.72, y: 28 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ delay: 0.28 + index * 0.1, duration: 0.62, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -6, scale: 1.02 }}
    >
      <div className={`absolute inset-0 -z-10 bg-gradient-to-br ${item.tint}`} />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
      <div className="mb-5 flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/45">{item.eyebrow}</span>
        <span className="grid h-8 w-8 place-items-center rounded-xl border border-white/10 bg-black/20 text-white/75">
          <Icon size={15} />
        </span>
      </div>
      <h2 className="text-[17px] font-medium tracking-[-0.03em] text-white">{item.title}</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-white/50 max-[720px]:hidden">{item.detail}</p>
      {item.source && actions[0] ? (
        <div className="prism-card-action mt-5">
          <ActionButton action={actions[0]} card={item.source} primary />
        </div>
      ) : (
        <span className="mt-5 inline-flex items-center gap-1.5 text-[11px] font-semibold text-white/70">
          {item.actionLabel}<ArrowUpRight size={13} />
        </span>
      )}
    </motion.article>
  )
}

function SpatialDropZone({
  sound,
  speaking,
  onSpeak,
}: {
  sound: () => void
  speaking: boolean
  onSpeak: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const job = useJob()
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const busy = job.status === 'uploading' || job.status === 'running'

  const accept = useCallback((file?: File) => {
    if (!file || busy || speaking) return
    const problem = validateImage(file)
    setError(problem)
    if (!problem) void job.start(file)
  }, [busy, job, speaking])

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = event.clipboardData?.files[0]
      if (!file) return
      event.preventDefault()
      accept(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [accept])

  const status = busy
    ? (job.currentStage && STAGE_COPY[job.currentStage]) || 'Reading your screenshot locally…'
    : job.status === 'done'
      ? 'Screenshot understood. Cards are blooming.'
      : 'Drop a screenshot here, or tap to speak.'

  return (
    <motion.div
      className="pointer-events-auto absolute inset-x-4 bottom-5 z-30 mx-auto max-w-2xl"
      initial={{ opacity: 0, y: 28 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.65, duration: 0.5 }}
    >
      <div
        className={`group flex min-h-[92px] items-center gap-4 rounded-2xl border border-dashed px-5 py-4 backdrop-blur-xl transition-all duration-300 ${
          dragging
            ? 'border-cyan-200/70 bg-cyan-300/10 shadow-[0_0_44px_rgba(103,232,249,0.18)]'
            : 'border-white/20 bg-black/40 shadow-[0_18px_70px_rgba(0,0,0,0.4)] hover:border-white/45 hover:bg-white/[0.07]'
        }`}
        onMouseEnter={sound}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }}
        onDrop={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          accept(event.dataTransfer.files[0])
        }}
      >
        <button
          type="button"
          className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.07] text-white/75 transition group-hover:text-white"
          aria-label="Choose a screenshot"
          disabled={busy || speaking}
          onClick={() => input.current?.click()}
        >
          {busy ? <Sparkles size={20} className="animate-pulse text-cyan-200" /> : <Upload size={20} />}
        </button>
        <button type="button" className="min-w-0 flex-1 text-left" disabled={busy || speaking} onClick={() => input.current?.click()}>
          <strong className="block truncate text-sm font-medium text-white">{status}</strong>
          <span className="mt-1 block text-[11px] text-white/40">
            {error ?? job.error ?? 'PNG, JPEG or WebP · image bytes stay on this device'}
          </span>
        </button>
        <button
          type="button"
          className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl border text-white/70 transition ${
            speaking
              ? 'border-violet-300/40 bg-violet-400/15 text-violet-100'
              : 'border-white/10 bg-white/[0.07] hover:border-violet-300/30 hover:text-violet-200'
          }`}
          aria-label={speaking ? 'Close voice input' : 'Tap to speak'}
          aria-pressed={speaking}
          disabled={busy && !speaking}
          onClick={onSpeak}
        >
          <Mic size={19} />
        </button>
      </div>
      <input
        ref={input}
        hidden
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        onChange={(event) => {
          accept(event.target.files?.[0])
          event.target.value = ''
        }}
      />
    </motion.div>
  )
}

function bloomFromCards(cards: Card[]): BloomCard[] {
  return cards.slice(0, 4).map((card, index) => ({
    id: card.id,
    eyebrow: card.kind.replace('_', ' '),
    title: card.title,
    detail: card.snippet ?? card.subtitle ?? card.source,
    actionLabel: card.actions[0]?.label ?? 'Open',
    icon: KIND_ICON[card.kind],
    slot: CARD_SLOTS[index],
    tint: KIND_TINT[card.kind],
    source: card,
  }))
}

function useSpatialScene() {
  const [allow3d, setAllow3d] = useState(false)

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION_QUERY)
    const sync = () => setAllow3d(detectWebGL2() && !prefersReducedMotion())
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  return allow3d
}

function PrismShell({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add('prism-mode')
    return () => document.body.classList.remove('prism-mode')
  }, [])
  return <>{children}</>
}

export function PrismDashboard() {
  const sound = useSynthSound()
  const job = useJob()
  const allow3d = useSpatialScene()
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [voicePending, setVoicePending] = useState(false)
  const cards = useMemo(
    () => (job.result?.cards?.length ? bloomFromCards(job.result.cards) : SAMPLE_CARDS),
    [job.result],
  )

  return (
    <MotionConfig reducedMotion="user">
      <PrismShell>
        <main className="fixed inset-0 isolate z-0 overflow-hidden bg-[#070910] font-sans text-white">
          {allow3d ? <AmbientGallery /> : <FallbackAura />}
          <div className="pointer-events-none absolute inset-0 -z-[5] bg-[radial-gradient(circle_at_center,transparent_0%,rgba(7,9,16,0.28)_46%,rgba(7,9,16,0.88)_100%)]" />
          <div className="pointer-events-none absolute inset-0 -z-[4] opacity-[0.05] [background-image:url('data:image/svg+xml,%3Csvg_viewBox=%220_0_160_160%22_xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter_id=%22n%22%3E%3CfeTurbulence_type=%22fractalNoise%22_baseFrequency=%220.85%22_numOctaves=%223%22_stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect_width=%22100%25%22_height=%22100%25%22_filter=%22url(%23n)%22/%3E%3C/svg%3E')]" />

          <AppChrome current="prism" end={<p className="app-chrome-status">Private intelligence</p>} />

          <section className="pointer-events-none absolute inset-0 z-10" aria-label="Action cards">
            {cards.map((item, index) => <SpatialCard key={item.id} item={item} index={index} />)}
          </section>

          <section className="pointer-events-none absolute inset-0 z-20 grid place-items-center" aria-label="Privacy mode">
            <HardwareToggle sound={sound} />
          </section>

          <p className="pointer-events-none absolute bottom-36 left-1/2 z-20 hidden -translate-x-1/2 items-center gap-2 text-[10px] tracking-[0.18em] text-white/28 sm:flex">
            <ImagePlus size={12} /> INTENT BLOOMS HERE
          </p>

          {voiceOpen && (
            <div
              id="prism-voice-controls"
              className="pointer-events-auto absolute inset-x-4 bottom-32 z-40 mx-auto max-w-2xl rounded-2xl border border-white/10 bg-black/55 p-2 shadow-[0_20px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl"
              style={{ ['--chat-ink' as string]: '#f4f1ea', ['--chat-muted' as string]: '#b9b3c6', ['--chat-surface' as string]: 'transparent', ['--chat-sunk' as string]: '#12141c', ['--chat-line' as string]: 'rgba(255,255,255,0.12)', ['--chat-me' as string]: '#8f7cff' }}
            >
              <VoiceCapture
                autoStart
                disabled={job.status === 'uploading' || job.status === 'running'}
                onBusyChange={(busy) => {
                  if (!reserveVoiceSlot(busy)) return false
                  setVoicePending(busy)
                  return true
                }}
                onJob={(jobId) => { job.followVoice(jobId) }}
                onClose={() => setVoiceOpen(false)}
              />
            </div>
          )}

          <SpatialDropZone
            sound={sound}
            speaking={voiceOpen || voicePending}
            onSpeak={() => {
              sound()
              setVoiceOpen((open) => !open)
            }}
          />

          <div className="pointer-events-none absolute left-6 top-1/2 z-20 hidden -translate-y-1/2 items-center gap-2 text-[10px] tracking-[0.16em] text-white/25 lg:flex">
            <ShieldCheck size={12} /> ON DEVICE
          </div>
        </main>
      </PrismShell>
    </MotionConfig>
  )
}
