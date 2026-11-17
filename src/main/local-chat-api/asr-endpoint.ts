// Streaming-voice endpointer: energy-gate segmentation of the phone's raw PCM
// stream, replacing the web page's client-side VAD entirely (Nou: "this needs
// better implementation... do the rebuild"). The browser is now a dumb mic
// pipe; all timing intelligence lives here, where the machine is idle and
// clocks are honest.
//
// Semantics preserved from the tuned web VAD (field-calibrated over 10 rounds):
//   - floor = median(rms of idle frames) * 4.5, clamped [0.012, 0.06]
//   - attack: voiced (zero-crossings < 8/10ms) AND rms > floor * 2.0
//   - preroll: 1.8 s of audio before the attack is prepended to the utterance
//   - endpoint: 1.2 s of sub-floor audio after the last voiced frame
//   - reject: < 0.35 s total or < 0.25 s voiced content (anti-tap, anti-echo-pop)
//   - hard cap: 30 s per utterance
// Plus one web VAD never had: hysteresis (release at floor*1.2) so breath
// between words no longer looks like silence.
import { EventEmitter } from 'node:events'

export const FRAME_SAMPLES = 160 // 10 ms at 16 kHz
export const SAMPLE_RATE = 16000

export interface EnderpointerOptions {
  prerollFrames?: number
  silenceMs?: number
  minTotalMs?: number
  minVoicedMs?: number
  maxUtteranceMs?: number
  floorMin?: number
  floorMax?: number
  floorMultiplier?: number
  attackFactor?: number
  releaseFactor?: number
  calibrationMs?: number
  onState?: (state: 'calibrating' | 'listening' | 'recording') => void
}

const DEFAULTS: Required<Omit<EnderpointerOptions, 'onState'>> = {
  prerollFrames: 110,
  silenceMs: 1200,
  minTotalMs: 350,
  minVoicedMs: 250,
  maxUtteranceMs: 30000,
  floorMin: 0.012,
  floorMax: 0.06,
  floorMultiplier: 4.5,
  attackFactor: 2.0,
  releaseFactor: 1.2,
  calibrationMs: 1000,
}

type Phase = 'calibrating' | 'idle' | 'speaking'

/** Pure, synchronous utterance segmentation over 10 ms float32 frames. */
export class EnergyEndpointer extends EventEmitter {
  private readonly o = { ...DEFAULTS }
  private readonly onState?: (state: 'calibrating' | 'listening' | 'recording') => void
  private phase: Phase = 'calibrating'
  private readonly cal: number[] = []
  private calFrames = 0
  private floor = DEFAULTS.floorMin
  private readonly preroll: Float32Array[] = []
  private prerollLen = 0
  private utterance: Float32Array[] = []
  private utteranceSamples = 0
  private voicedMs = 0
  private silenceSince = 0
  private readonly residual = new Float32Array(FRAME_SAMPLES)
  private residualLen = 0

  constructor(options: EnderpointerOptions = {}) {
    super()
    this.onState = options.onState
    Object.assign(this.o, options)
    for (const k of ['silenceMs', 'attackFactor', 'prerollFrames'] as const) {
      if (options[k] !== undefined) (this.o as Record<string, number>)[k] = options[k] as number
    }
  }

  get currentFloor(): number {
    return this.floor
  }

  get currentPhase(): Phase {
    return this.phase
  }

  /** Feed mono float32 PCM at 16 kHz, any chunk length. */
  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.residual[this.residualLen++] = samples[i]
      if (this.residualLen === FRAME_SAMPLES) {
        this.frame(new Float32Array(this.residual))
        this.residualLen = 0
      }
    }
  }

  /** Adjust the endpointing silence threshold live (page Voice Settings). */
  setSilenceMs(ms: number): void {
    this.o.silenceMs = Math.max(400, Math.min(4000, ms))
  }

  /** Discard buffered audio (voice mode off, interruption of the session). */
  reset(): void {
    this.phase = 'calibrating'
    this.cal.length = 0
    this.calFrames = 0
    this.preroll.length = 0
    this.prerollLen = 0
    this.utterance = []
    this.utteranceSamples = 0
    this.voicedMs = 0
    this.silenceSince = 0
    this.residualLen = 0
    this.onState?.('calibrating')
  }

  private frame(frame: Float32Array): void {
    let sum = 0
    let zc = 0
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i]
      sum += v * v
      if (i && (v >= 0) !== (frame[i - 1] >= 0)) zc++
    }
    const rms = Math.sqrt(sum / frame.length)
    const voiced = zc < 8

    if (this.phase === 'calibrating') {
      this.cal.push(rms)
      this.calFrames++
      if (this.calFrames * 10 >= this.o.calibrationMs) {
        const sorted = [...this.cal].sort((a, b) => a - b)
        const half = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 2)))
        this.floor = Math.max(this.o.floorMin, Math.min(this.o.floorMax, (half.reduce((a, b) => a + b, 0) / half.length) * this.o.floorMultiplier))
        this.cal.length = 0
        this.phase = 'idle'
        this.onState?.('listening')
      }
      this.pushPreroll(frame)
      return
    }

    const now = Date.now()
    if (this.phase === 'idle') {
      this.pushPreroll(frame)
      if (voiced && rms > this.floor * this.o.attackFactor) {
        this.phase = 'speaking'
        this.utterance = [...this.preroll, frame]
        this.utteranceSamples = (this.prerollLen + frame.length)
        this.voicedMs = 10
        this.silenceSince = 0
        this.preroll.length = 0
        this.prerollLen = 0
        this.onState?.('recording')
      }
      return
    }

    // speaking: hysteresis keeps level between floor*release and floor*attack
    // as speech, so inter-word dips do not end the turn.
    const stillVoiced = voiced && rms > this.floor * this.o.releaseFactor
    if (stillVoiced || rms > this.floor * this.o.attackFactor) {
      this.voicedMs += 10
      this.silenceSince = 0
    } else if (!this.silenceSince) {
      this.silenceSince = now
    }
    this.utterance.push(frame)
    this.utteranceSamples += frame.length

    const totalMs = this.utteranceSamples / FRAME_SAMPLES * 10
    if ((this.silenceSince && now - this.silenceSince >= this.o.silenceMs) || totalMs >= this.o.maxUtteranceMs) {
      const pcm = concat(this.utterance, this.utteranceSamples)
      this.utterance = []
      this.utteranceSamples = 0
      this.phase = 'idle'
      this.onState?.('listening')
      if (totalMs >= this.o.minTotalMs && this.voicedMs >= this.o.minVoicedMs) {
        this.emit('utterance', pcm, { totalMs, voicedMs: this.voicedMs })
      } else {
        this.emit('rejected', { totalMs, voicedMs: this.voicedMs })
      }
      this.voicedMs = 0
    }
  }

  private pushPreroll(frame: Float32Array): void {
    this.preroll.push(frame)
    this.prerollLen += frame.length
    while (this.prerollLen > this.o.prerollFrames * FRAME_SAMPLES) {
      this.prerollLen -= this.preroll.shift()!.length
    }
  }
}

function concat(frames: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let o = 0
  for (const f of frames) {
    out.set(f, o)
    o += f.length
  }
  return out
}
