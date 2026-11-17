// Sherpa-onnx offline websocket ASR engine: spawned on demand, speaks the
// protocol verified by probe/sherapaprobe.cjs (first binary message =
// int32LE sample_rate + int32LE total float32 bytes + first chunk; further
// binary messages raw float32 until the byte count is exactly met; server
// answers one JSON {text,...}). One connection per utterance; the server
// pipelines decodes internally.
import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { WebSocket } from 'ws'

export interface SherpaEngineOptions {
  binPath: string // sherpa-onnx-offline-websocket-server.exe
  modelDir: string // dir with encoder.int8.onnx / decoder / joiner / tokens.txt
  port: number
  numThreads?: number
  spawnTimeoutMs?: number
  decodeTimeoutMs?: number
}

const MODEL_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'] as const

export class SherpaEngine {
  private proc: ChildProcess | null = null
  private starting: Promise<void> | null = null

  constructor(private readonly o: SherpaEngineOptions) {}

  get running(): boolean {
    return this.proc !== null && !this.proc.killed
  }

  /** Validate paths, spawn the server if needed, wait for the port. */
  async ensure(): Promise<void> {
    if (this.running && (await this.probePort(500))) return
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(): Promise<void> {
    const { binPath, modelDir, port } = this.o
    for (const f of [binPath, ...MODEL_FILES.map(f => path.join(modelDir, f))]) {
      if (!exists(f)) throw new Error(`ASR stream: missing ${path.basename(f)}`)
    }
    this.stop()
    const args = [
      `--port=${port}`,
      `--num-threads=${this.o.numThreads ?? 8}`,
      `--encoder=${path.join(modelDir, 'encoder.int8.onnx')}`,
      `--decoder=${path.join(modelDir, 'decoder.int8.onnx')}`,
      `--joiner=${path.join(modelDir, 'joiner.int8.onnx')}`,
      `--tokens=${path.join(modelDir, 'tokens.txt')}`,
      '--model-type=nemo_transducer',
    ]
    const proc = spawn(binPath, args, { cwd: path.dirname(binPath), windowsHide: true, stdio: 'ignore' })
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null
    })
    this.proc = proc
    const deadline = Date.now() + (this.o.spawnTimeoutMs ?? 30000)
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`ASR stream server exited (${proc.exitCode}) during start`)
      if (await this.probePort(400)) return
      await sleep(400)
    }
    this.stop()
    throw new Error('ASR stream server did not open its port in time')
  }

  stop(): void {
    const proc = this.proc
    this.proc = null
    if (proc && proc.exitCode === null) {
      try {
        proc.kill()
      } catch {}
    }
  }

  /** Transcribe one complete utterance. Empty text is a valid abstention. */
  async transcribe(samples: Float32Array, signal?: AbortSignal): Promise<string> {
    await this.ensure()
    const totalBytes = samples.byteLength
    const text = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.o.port}`)
      let settled = false
      const finish = (ok: boolean, value: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        try {
          ws.close()
        } catch {}
        ok ? resolve(value) : reject(new Error(value))
      }
      const timer = setTimeout(() => finish(false, 'ASR stream decode timed out'), this.o.decodeTimeoutMs ?? 30000)
      const onAbort = () => finish(false, 'aborted')
      signal?.addEventListener('abort', onAbort, { once: true })
      ws.on('open', () => {
        try {
          // Wire format: int32LE sample_rate + int32LE float32 byte count +
          // the raw float32 samples. Build one little-endian byte view rather
          // than relying on Buffer's platform endianness.
          const msg = new Uint8Array(8 + totalBytes)
          const view = new DataView(msg.buffer)
          view.setUint32(0, 16000, true)
          view.setUint32(4, totalBytes, true)
          new Float32Array(msg.buffer, 8).set(samples)
          ws.send(msg)
        } catch (error) {
          finish(false, `ASR stream send failed: ${error instanceof Error ? error.message : error}`)
        }
      })
      ws.on('message', data => {
        try {
          const parsed = JSON.parse(data.toString('utf8')) as { text?: unknown }
          finish(true, typeof parsed.text === 'string' ? parsed.text.trim() : '')
        } catch {
          finish(false, 'ASR stream returned malformed JSON')
        }
      })
      ws.on('error', () => finish(false, 'ASR stream connection failed'))
      ws.on('close', code => finish(false, `ASR stream closed (${code})`))
    })
    return text
  }

  private probePort(timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port: this.o.port, timeout: timeoutMs })
      socket.on('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
      socket.on('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })
  }
}

function exists(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
