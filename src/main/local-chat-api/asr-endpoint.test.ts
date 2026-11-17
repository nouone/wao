import { describe, expect, it, vi } from 'vitest'
import { EnergyEndpointer, FRAME_SAMPLES, SAMPLE_RATE } from './asr-endpoint'

// Deterministic clock: the endpointer measures silence gaps with Date.now().
function makeClock(start = 1_000_000) {
  let now = start
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  return { advance: (ms: number) => (now += ms), at: () => now }
}

// zc semantics (inherited from the web VAD): voiced frames are low-frequency
// speech (fewer than 8 zero-crossings per 10 ms); hisses and DC are unvoiced.
// period 48 -> 3 crossings (voiced); period 2 -> 80 crossings (unvoiced hiss).
const frame = (rms: number, voiced = true): Float32Array => {
  const f = new Float32Array(FRAME_SAMPLES)
  const period = voiced ? 48 : 2
  for (let i = 0; i < FRAME_SAMPLES; i++) f[i] = rms * (i % period < period / 2 ? 1 : -1)
  return f
}

function feed(ep: EnergyEndpointer, seconds: number, rms: number, voiced = true): void {
  const frames = Math.round((seconds * SAMPLE_RATE) / FRAME_SAMPLES)
  for (let i = 0; i < frames; i++) {
    ep.push(frame(rms, voiced))
    makeAdvance()
  }
}

let clock: ReturnType<typeof makeClock>
function makeAdvance(): void {
  clock.advance(10) // each frame = 10 ms
}

describe('EnergyEndpointer', () => {
  it('calibrates on idle frames, opens on loud speech, endpoints after the silence window', () => {
    clock = makeClock()
    const states: string[] = []
    const ep = new EnergyEndpointer({ onState: (s) => states.push(s), silenceMs: 1200 })
    const utterances: { pcm: Float32Array; voicedMs: number }[] = []
    ep.on('utterance', (pcm: Float32Array, meta: { voicedMs: number }) => utterances.push({ pcm, voicedMs: meta.voicedMs }))

    // 1.2 s of quiet room tone: calibration window (1 s) then idle.
    feed(ep, 1.2, 0.001)
    expect(states).toContain('listening')
    expect(utterances).toHaveLength(0)

    // Loud speech for 1 s.
    feed(ep, 1.0, 0.2)
    // 1.5 s of silence crosses the 1.2 s endpoint window.
    feed(ep, 1.5, 0.0005)
    expect(utterances).toHaveLength(1)
    const pcm = utterances[0].pcm
    // utterance = 1.8 s preroll + 1.0 s speech + trailing silence until the
    // endpoint. Bounds are tolerant of the harness clock step (frames advance
    // the mock clock after each push); the exact frame count is not the point
    // - the invariants below are: preroll before speech, silence after.
    expect(pcm.length).toBeGreaterThanOrEqual(Math.round(3.2 * SAMPLE_RATE))
    expect(pcm.length).toBeLessThanOrEqual(Math.round(4.2 * SAMPLE_RATE))
    // the preroll kept the audio from before the attack: first samples are quiet room tone
    let firstVoiced = 0
    while (firstVoiced < pcm.length && Math.abs(pcm[firstVoiced]) < 0.05) firstVoiced++
    // preroll holds ~1.8 s of pre-attack room tone, so speech onset sits near
    // the end of it (not at sample 0, which is what an implementation without
    // lookback would produce)
    expect(firstVoiced).toBeGreaterThan(Math.round(1.0 * SAMPLE_RATE))
    expect(firstVoiced).toBeLessThan(Math.round(2.8 * SAMPLE_RATE))
  })

  it('rejects tap-noise blips below the voiced floor', () => {
    clock = makeClock()
    const ep = new EnergyEndpointer()
    const events: string[] = []
    ep.on('utterance', () => events.push('utterance'))
    ep.on('rejected', () => events.push('rejected'))
    feed(ep, 1.2, 0.001)
    feed(ep, 0.05, 0.3) // 50 ms blip
    feed(ep, 1.5, 0.0005)
    expect(events).toEqual(['rejected'])
  })

  it('rejects unvoiced hiss (door slam, fan gust) even when loud', () => {
    clock = makeClock()
    const ep = new EnergyEndpointer()
    const events: string[] = []
    ep.on('utterance', () => events.push('utterance'))
    ep.on('rejected', () => events.push('rejected'))
    feed(ep, 1.2, 0.001)
    feed(ep, 1.0, 0.3, false) // 1 s of loud hiss: crosses the level gate but not zc
    feed(ep, 1.5, 0.0005)
    // the gate never opens for hiss, so no utterance and no rejection event
    expect(events).toEqual([])
    expect(ep.currentPhase).toBe('idle')
  })

  it('hysteresis keeps inter-word dips from ending the turn', () => {
    clock = makeClock()
    const ep = new EnergyEndpointer({ silenceMs: 1200 })
    const utterances: Float32Array[] = []
    ep.on('utterance', (pcm: Float32Array) => utterances.push(pcm))
    feed(ep, 1.2, 0.001)
    feed(ep, 0.5, 0.2)
    feed(ep, 0.8, 0.018) // dip above floor*release but below attack
    feed(ep, 0.5, 0.2)
    feed(ep, 1.4, 0.0005)
    expect(utterances).toHaveLength(1)
    // 0.5 + 0.8 + 0.5 + 1.2 endpoint tail (preroll consumed by calibration frames)
    expect(utterances[0].length).toBeGreaterThanOrEqual(Math.round(3.0 * SAMPLE_RATE))
  })

  it('setSilenceMs changes the endpoint window live', () => {
    clock = makeClock()
    const ep = new EnergyEndpointer({ silenceMs: 3000 })
    const utterances: number[] = []
    ep.on('utterance', (pcm: Float32Array) => utterances.push(pcm.length))
    ep.setSilenceMs(500)
    feed(ep, 1.2, 0.001)
    feed(ep, 0.6, 0.2)
    feed(ep, 0.8, 0.0005) // 800 ms > 500 ms window
    expect(utterances).toHaveLength(1)
  })

  it('reset discards buffered audio and restarts calibration', () => {
    clock = makeClock()
    const ep = new EnergyEndpointer()
    const events: string[] = []
    ep.on('utterance', () => events.push('utterance'))
    ep.on('rejected', () => events.push('rejected'))
    feed(ep, 1.2, 0.001)
    feed(ep, 0.5, 0.2)
    ep.reset()
    feed(ep, 1.5, 0.0005)
    expect(events).toEqual([])
  })
})
