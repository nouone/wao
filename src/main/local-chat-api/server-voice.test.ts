import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startLocalChatApi } from './server'
import { FRAME_SAMPLES } from './asr-endpoint'

const token = 'test-only-token-'.repeat(4)
const running: Awaited<ReturnType<typeof startLocalChatApi>>[] = []
afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
})

// Real WebSocket round trip against an ephemeral port: verifies the upgrade
// routing, auth, the stream event protocol, and that a configured-but-broken
// engine surfaces an actionable error instead of killing the connection.
async function connect(server: { port: number }, opts: { auth?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/voice/stream`, opts.auth === false ? [] : ['wao-api', token])
  const messages: Record<string, unknown>[] = []
  ws.on('message', (d) => messages.push(JSON.parse(String(d))))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
    setTimeout(() => reject(new Error('ws open timeout')), 4000)
  })
  return { ws, messages }
}

const loud = () => {
  // 67 Hz square wave at 0.3 amplitude, one frame
  const f = new Int16Array(FRAME_SAMPLES)
  for (let i = 0; i < FRAME_SAMPLES; i++) f[i] = (i % 48 < 24 ? 1 : -1) * 9830
  return Buffer.from(f.buffer)
}
const quiet = () => Buffer.alloc(FRAME_SAMPLES * 2)

it('streams voice: calibrates, records, and reports an engine error without dropping the socket', async () => {
  const server = await startLocalChatApi({
    port: 0,
    token,
    dispatch: async () => ({ status: 200, body: {} }),
    voiceStream: { binPath: 'C:/missing/sherpa.exe', modelDir: 'C:/missing/model' },
  })
  running.push(server)
  const { ws, messages } = await connect(server)
  const saw = async (pred: (m: Record<string, unknown>) => boolean, ms = 5000) => {
    const t0 = Date.now()
    while (!messages.some(pred)) {
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for event; got ' + JSON.stringify(messages))
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  ws.send(JSON.stringify({ t: 'cfg', silenceMs: 500 }))
  // 1.2 s of quiet frames: calibration window completes
  for (let i = 0; i < 120; i++) ws.send(quiet())
  await saw((m) => m.t === 'state' && m.s === 'listening')
  // speech then silence: endpoint opens the gate, fires, and the missing
  // engine answers with an actionable error
  for (let i = 0; i < 100; i++) ws.send(loud())
  await saw((m) => m.t === 'state' && m.s === 'recording')
  for (let i = 0; i < 80; i++) ws.send(quiet())
  // the endpointer needs frames to *arrive* after the silence window elapses
  // (it is frame-driven): keep trickling quiet audio across the 500 ms line.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 60))
    ws.send(quiet())
  }
  await saw((m) => m.t === 'error' && /missing|not reachable|did not open/i.test(String(m.error)))
  expect(ws.readyState).toBe(WebSocket.OPEN)
  ws.close()
}, 30000)

it('rejects unauthenticated voice stream upgrades with 403', async () => {
  const server = await startLocalChatApi({
    port: 0,
    token,
    dispatch: async () => ({ status: 200, body: {} }),
    voiceStream: { binPath: 'C:/missing/sherpa.exe', modelDir: 'C:/missing/model' },
  })
  running.push(server)
  await expect(connect(server, { auth: false })).rejects.toBeTruthy()
})

it('refuses the voice stream route entirely when no engine is configured', async () => {
  const server = await startLocalChatApi({ port: 0, token, dispatch: async () => ({ status: 200, body: {} }) })
  running.push(server)
  await expect(connect(server)).rejects.toBeTruthy()
})
