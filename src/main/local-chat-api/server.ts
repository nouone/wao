import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  normalizeTailnetOrigin,
  normalizeLanAddress,
  type LocalChatCall,
  type LocalChatResult,
} from '../../shared/local-chat-api'
import { BROWSER_COOKIE, browserCookie, createBrowserPairing, readBrowserCookie } from './browser-pairing'
import { LOCAL_CHAT_WEB_UI } from './web-ui'
import { createWebChatPresentation } from './presentation'
import { EnergyEndpointer, SAMPLE_RATE } from './asr-endpoint'
import { SherpaEngine } from './asr-sherpa'
import { VOICE_WORKLET_CODE } from './voice-worklet'

class RequestError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}
async function readJson(req: IncomingMessage, limit = 65536) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new RequestError(415, 'Use application/json')
  let size = 0
  const chunks: Uint8Array[] = []
  const stream = req as IncomingMessage & { iterator(options: { destroyOnReturn: boolean }): AsyncIterable<Uint8Array> }
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    size += chunk.byteLength
    if (size > limit) {
      req.resume()
      throw new RequestError(413, 'Message body too large')
    }
    chunks.push(new Uint8Array(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, 'Invalid JSON')
  }
}

type Dispatch = (call: LocalChatCall) => Promise<LocalChatResult>
export async function startLocalChatApi(options: {
  port: number
  token: string
  dispatch: Dispatch
  publicOrigin?: string
  lanAddress?: string
  /** True when the renderer IPC queue is saturated; the snapshot loop skips a poll. */
  rendererBusy?: () => boolean
  /**
   * Streaming voice: when set, /api/voice/stream accepts raw mic PCM and the
   * desktop does segmentation + transcription (sherpa-onnx). When unset the
   * page keeps its legacy whole-utterance HTTP path.
   */
  voiceStream?: { binPath: string; modelDir: string; port?: number } | null
}) {
  if (options.token.length < 32) throw new Error('The API token must have at least 32 characters.')
  let currentToken = options.token
  const publicOrigin = normalizeTailnetOrigin(options.publicOrigin)
  const lanAddress = normalizeLanAddress(options.lanAddress)
  const lanOrigin = lanAddress ? `http://${lanAddress}:${options.port}` : undefined
  const publicHost = publicOrigin ? new URL(publicOrigin).host : undefined
  const pairing = createBrowserPairing(() => currentToken)
  const browserAuthorized = (req: IncomingMessage) => pairing.valid(readBrowserCookie(req.headers.cookie))
  const secureCookie = (req: IncomingMessage) => Boolean(publicHost && req.headers.host === publicHost)

  const present = createWebChatPresentation()
  const authorized = (candidate: string) => {
    const a = new TextEncoder().encode(candidate),
      b = new TextEncoder().encode(currentToken)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  const hostAllowed = (req: IncomingMessage) => {
    const host = req.headers.host || ''
    return (
      !req.headers['tailscale-funnel-request'] &&
      (host === `127.0.0.1:${port}` ||
        host === `localhost:${port}` ||
        Boolean(publicHost && host === publicHost) ||
        Boolean(lanAddress && host === `${lanAddress}:${port}`))
    )
  }
  const originAllowed = (req: IncomingMessage) =>
    !req.headers.origin ||
    req.headers.origin === `http://127.0.0.1:${port}` ||
    req.headers.origin === `http://localhost:${port}` ||
    Boolean(publicOrigin && req.headers.origin === publicOrigin) ||
    Boolean(lanOrigin && req.headers.origin === lanOrigin)
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    res.end(JSON.stringify(body))
  }
  let port = options.port
  const server = createServer(async (req, res) => {
    try {
      if (!hostAllowed(req) || !originAllowed(req)) {
        reply(res, 403, { error: 'Origin or Host rejected' })
        return
      }
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
      if (req.method === 'GET' && url.pathname === '/api/status') {
        reply(res, 200, { app: 'wao', apiVersion: 1 })
        return
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            // 'self' is required for the audio worklet module: WebKit
            // enforces the document's script-src on audioWorklet.addModule,
            // and 'unsafe-inline' alone permits ONLY inline scripts - the
            // same-origin /api/voice/worklet.js load is an external script
            // and was rejected with a bare SecurityError (field #21:
            // "mic fail [worklet]: SecurityError | ctx=y stream=y").
            // 'self' adds no remote origins; the page has no other scripts.
            "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        })
        res.end(LOCAL_CHAT_WEB_UI)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/voice/worklet.js') {
        // Same strict CSP as the page; script-src 'unsafe-inline' does not
        // list data:, so the worklet must be served as a same-origin file.
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        })
        res.end(VOICE_WORKLET_CODE)
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        const body = await readJson(req, 2048)
        const remembered = body?.remember === true
        const credential =
          typeof body?.code === 'string' && body.code.length <= 100 ? pairing.redeem(body.code, remembered) : undefined
        if (!credential) {
          reply(res, 401, { error: 'Pairing code expired or already used. Create a new code in Desktop.' })
          return
        }
        res.setHeader('Set-Cookie', browserCookie(credential, remembered, secureCookie(req)))
        reply(res, 200, { paired: true })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        res.setHeader(
          'Set-Cookie',
          `${BROWSER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie(req) ? '; Secure' : ''}`
        )
        reply(res, 200, { signedOut: true })
        return
      }
      if (!authorized(req.headers.authorization?.replace(/^Bearer /i, '') || '') && !browserAuthorized(req)) {
        reply(res, 401, { error: 'Bearer token required' })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/session') {
        const body = await readJson(req, 2048)
        const remembered = body?.remember === true
        res.setHeader('Set-Cookie', browserCookie(pairing.issue(remembered), remembered, secureCookie(req)))
        reply(res, 200, { paired: true })
        return
      }
      let call: LocalChatCall
      const match = /^\/api\/chats\/([^/]+)(\/messages|\/stop|\/steer)?$/.exec(url.pathname)
      const speechMatch = /^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/speech$/.exec(url.pathname)
      if (req.method === 'POST' && url.pathname === '/api/voice/asr') {
        // Raw capture from a browser voice frontend: WAV bytes as base64
        // (~4.3MB per 10s at 16kHz mono; capped at 12MB decoded).
        const input: unknown = await readJson(req, 17 * 1024 * 1024)
        const audio = (input as { audio?: unknown } | null)?.audio
        if (typeof audio !== 'string' || !audio.length) {
          reply(res, 400, { error: 'audio must be base64 WAV bytes' })
          return
        }
        call = { action: 'asr', content: audio }
      } else if (req.method === 'POST' && url.pathname === '/api/voice/speak') {
        const input: unknown = await readJson(req, 16 * 1024)
        const text = (input as { text?: unknown } | null)?.text
        if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
          reply(res, 400, { error: 'text must be non-empty (max 4000 characters)' })
          return
        }
        call = { action: 'speak', content: text }
      } else if (req.method === 'POST' && url.pathname === '/api/voice/note') {
        const input: unknown = await readJson(req, 1024)
        const msg = (input as { msg?: unknown } | null)?.msg
        if (typeof msg !== 'string' || !msg.trim()) {
          reply(res, 400, { error: 'msg required' })
          return
        }
        call = { action: 'voice-note', content: msg }
      } else if (req.method === 'POST' && speechMatch) {
        await readJson(req, 2048)
        call = {action:'speech',chatId:decodeURIComponent(speechMatch[1]),messageId:decodeURIComponent(speechMatch[2])}
      } else if (req.method === 'POST' && url.pathname === '/api/chats') {
        if (Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'])
          await readJson(req, 1024)
        call = { action: 'create' }
      } else if (req.method === 'GET' && url.pathname === '/api/chats') call = { action: 'list' }
      else if (req.method === 'GET' && match && !match[2])
        call = { action: 'read', chatId: decodeURIComponent(match[1]) }
      else if (req.method === 'POST' && match?.[2] === '/stop')
        call = { action: 'stop', chatId: decodeURIComponent(match[1]) }
      else if (req.method === 'POST' && match?.[2] === '/steer')
        call = { action: 'steer', chatId: decodeURIComponent(match[1]) }
      else if (req.method === 'POST' && match?.[2]) {
        // Image attachments ride the same JSON body (base64); this route gets
        // a 10 MB ceiling while everything else keeps the 64 KB default.
        const input: unknown = await readJson(req, 10 * 1024 * 1024)
        const content = (input as { content?: unknown } | null)?.content
        const rawImage = (input as { image?: unknown } | null)?.image
        const image =
          rawImage && typeof rawImage === 'object'
            ? {
                data: (rawImage as { data?: unknown }).data,
                mime: (rawImage as { mime?: unknown }).mime,
              }
            : undefined
        const hasImage = Boolean(image && typeof image.data === 'string' && typeof image.mime === 'string')
        if (typeof content !== 'string' || (!content.trim() && !hasImage) || content.length > 60000) {
          reply(res, 400, { error: 'content must be text (max 60000 characters); required unless an image is attached' })
          return
        }
        // Optional per-send thinking level (voice clients). Unknown values are
        // rejected instead of ignored: silently dropping a caller's chosen
        // reasoning budget is exactly the confusion this field exists to end.
        const rawEffort = (input as { thinkingEffort?: unknown } | null)?.thinkingEffort
        if (
          rawEffort !== undefined &&
          rawEffort !== null &&
          !['off', 'low', 'medium', 'high'].includes(String(rawEffort))
        ) {
          reply(res, 400, { error: 'thinkingEffort must be off, low, medium or high' })
          return
        }
        const thinkingEffort =
          rawEffort === undefined || rawEffort === null
            ? undefined
            : (String(rawEffort) as 'off' | 'low' | 'medium' | 'high')
        call = {
          action: 'send',
          chatId: decodeURIComponent(match[1]),
          content,
          ...(thinkingEffort ? { thinkingEffort } : {}),
          ...(input && (input as { voice?: unknown }).voice === true ? { voice: true } : {}),
          ...(image && typeof image.data === 'string' && typeof image.mime === 'string'
            ? { image: { data: image.data, mime: image.mime } }
            : {}),
        }
      } else {
        reply(res, 404, { error: 'Route not found' })
        return
      }
      if (url.searchParams.has('cursor')) call.cursor = url.searchParams.get('cursor') || undefined
      const limit = Number(url.searchParams.get('limit') || 50)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        reply(res, 400, { error: 'limit must be 1 to 100' })
        return
      }
      call.limit = limit
      const result = await options.dispatch(call)
      if (call.action === 'speech' && result.status === 200) {
        const audio = result.body as {audioBase64?: unknown;contentType?: unknown}
        if (typeof audio?.audioBase64 !== 'string' || !audio.audioBase64.length || audio.audioBase64.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.audioBase64)) {
          reply(res, 502, {error:'Desktop returned invalid speech audio'})
          return
        }
        const buffer = Buffer.from(audio.audioBase64, 'base64')
        if (buffer.length > 8 * 1024 * 1024) {reply(res,502,{error:'Speech audio is too large'});return}
        res.writeHead(200, {'Content-Type':'audio/mpeg','Content-Length':buffer.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
        res.end(buffer)
        return
      }
      const output = call.action === 'read' && url.searchParams.get('view') === 'web' ? present(result) : result
      reply(res, output.status, output.body)
    } catch (error) {
      if (error instanceof RequestError && !res.headersSent) {
        reply(res, error.status, { error: error.message })
        return
      }
      if (!res.headersSent) reply(res, 503, { error: 'Desktop chat controller unavailable' })
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096, handleProtocols: () => 'wao-api' })
  // Streaming voice session: the page ships raw Int16 PCM; the endpointer
  // segments by energy (calibrated per connection), SherpaEngine transcribes
  // whole utterances over the offline websocket protocol. The engine process
  // is spawned lazily on first use and stopped when the API closes.
  const voiceEngine = options.voiceStream
    ? new SherpaEngine({
        binPath: options.voiceStream.binPath,
        modelDir: options.voiceStream.modelDir,
        port: options.voiceStream.port ?? 9101,
      })
    : null
  const voiceServer = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024, handleProtocols: () => 'wao-api' })
  server.on('upgrade', (req, socket, head) => {
    const protocols = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((v) => v.trim())
    const token =
      req.headers.authorization?.replace(/^Bearer /i, '') || (protocols[0] === 'wao-api' ? protocols[1] : '') || ''
    const route = (req.url || '').split('?')[0]
    const isVoice = Boolean(voiceEngine) && route === '/api/voice/stream'
    const target = isVoice ? voiceServer : sockets
    const capacity = isVoice ? voiceServer.clients.size < 2 : route === '/api/events' && sockets.clients.size < 8
    if (
      (!isVoice && route !== '/api/events') ||
      !capacity ||
      !hostAllowed(req) ||
      !originAllowed(req) ||
      (!authorized(token) && !browserAuthorized(req))
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws))
  })
  if (voiceEngine) {
    voiceServer.on('connection', (ws) => {
      let queue: Promise<void> = Promise.resolve()
      const send = (msg: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
      }
      const endpointer = new EnergyEndpointer({ onState: (s) => send({ t: 'state', s }) })
      endpointer.on('utterance', (pcm: Float32Array, meta: { totalMs: number; voicedMs: number }) => {
        // Serialize decodes per connection: results must arrive in speech order.
        queue = queue.then(async () => {
          try {
            const text = await voiceEngine!.transcribe(pcm)
            send({ t: 'final', text, totalMs: meta.totalMs })
          } catch (error) {
            send({ t: 'error', error: error instanceof Error ? error.message : 'Transcription failed.' })
          }
        })
      })
      endpointer.on('rejected', (meta: { totalMs: number; voicedMs: number }) => send({ t: 'rejected', ...meta }))
      ws.on('message', (data, isBinary) => {
        try {
          if (isBinary) {
            const bytes: Uint8Array = Buffer.isBuffer(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : Array.isArray(data)
                ? (() => {
                    const parts = data.map((p) => (Buffer.isBuffer(p) ? new Uint8Array(p.buffer, p.byteOffset, p.byteLength) : new Uint8Array(p as ArrayBuffer)))
                    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
                    let o = 0
                    for (const p of parts) {
                      out.set(p, o)
                      o += p.length
                    }
                    return out
                  })()
                : new Uint8Array(data as ArrayBuffer)
            const view = new DataView(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2) * 2)
            const samples = new Float32Array(view.byteLength / 2)
            for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
            endpointer.push(samples)
            return
          }
          const msg = JSON.parse(String(data)) as { t?: string; silenceMs?: number }
          if (msg.t === 'cfg' && typeof msg.silenceMs === 'number') endpointer.setSilenceMs(msg.silenceMs)
          else if (msg.t === 'reset') endpointer.reset()
        } catch {
          // Malformed frames are dropped; the stream keeps flowing.
        }
      })
      ws.on('close', () => endpointer.reset())
    })
  }
  sockets.on('connection', (ws) => {
    let chatId: string | undefined
    let browserView = false
    let busy = false
    let previous = ''
    // Liveness: unanswered pings mean the peer is gone (mobile NAT drops idle
    // sockets invisibly - the server would otherwise keep "sending" into a
    // black hole and the page would only notice via its own watchdog).
    let pongSeen = true
    ws.on('pong', () => { pongSeen = true })
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (!pongSeen) {
        ws.terminate()
        return
      }
      pongSeen = false
      ws.ping()
    }, 10000)
    ws.on('error', () => undefined)
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.type !== 'subscribe' || typeof message.chatId !== 'string' || message.chatId.length > 200)
          throw new Error()
        chatId = message.chatId
        browserView = message.view === 'web'
        previous = ''
      } catch {
        ws.close(1008, 'Send a subscribe message with chatId')
      }
    })
    // Transient read failures (revision races during generation, renderer
    // restart, IPC timeout) must not flash "Desktop unavailable" on the page:
    // only a status that persists across ~1s of polls is surfaced, and only
    // once per distinct status. Field evidence: every generation began with a
    // 409 snapshot (read racing the send's revision bump) that the page
    // painted as an error before the next snapshot cleared it.
    let errorStreak = 0
    let errorSent = 0
    // Live conversation list (field: the page only tracked the selected chat;
    // names, new chats and activity on other chats stayed stale until Refresh).
    // Every 8th tick (~2s), push the list whenever it changed. Same busy guard
    // as the snapshot poll, so one IPC read at a time per connection.
    let listTick = 0
    let previousList = ''
    const timer = setInterval(async () => {
      if (busy || !chatId || ws.readyState !== WebSocket.OPEN) return
      if (options.rendererBusy?.()) return // renderer queue saturated: skip this poll
      busy = true
      try {
        if (++listTick >= 8) {
          listTick = 0
          const page = await options.dispatch({ action: 'list', limit: 100 })
          if (page.status === 200 && page.body) {
            const body = page.body as { items?: unknown[]; folders?: unknown[] }
            const list = JSON.stringify({ type: 'chat.list', chats: body.items ?? [], folders: body.folders ?? [] })
            if (list !== previousList && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) {
              ws.send(list)
              previousList = list
            }
          }
        }
      } catch {
        // A failed list push is transient; the next tick retries. The page
        // keeps its last known list.
      }
      try {
        const raw = await options.dispatch({ action: 'read', chatId, limit: 100 })
        const transient = raw.status === 409 || raw.status === 503 || raw.status === 504
        if (transient) {
          errorStreak = raw.status === errorSent ? errorStreak + 1 : 1
          if (errorStreak < 4) return
        } else {
          errorStreak = 0
          errorSent = 0
        }
        const result = browserView ? present(raw) : raw
        const snapshot = JSON.stringify({ type: 'chat.snapshot', status: result.status, chat: result.body })
        if (snapshot !== previous && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) {
          ws.send(snapshot)
          previous = snapshot
          if (transient) errorSent = raw.status
        }
      } catch {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', error: 'Desktop unavailable' }))
      } finally {
        busy = false
      }
    }, 250)
    ws.once('close', () => { clearInterval(timer); clearInterval(heartbeat) })
  })
  let lanServer = lanAddress
    ? createServer(server.listeners('request')[0] as import('node:http').RequestListener)
    : undefined
  let lanBindError: string | undefined
  if (lanServer) {
    lanServer.requestTimeout = server.requestTimeout
    lanServer.headersTimeout = server.headersTimeout
    lanServer.on('upgrade', server.listeners('upgrade')[0] as never)
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address && typeof address !== 'string') port = address.port
  if (lanServer) {
    const lanListener = lanServer
    try {
      await new Promise<void>((resolve, reject) => {
        lanListener.once('error', reject)
        lanListener.listen(port, lanAddress, resolve)
      })
    } catch (error) {
      // A stale saved LAN address (the machine moved networks) must not take
      // the whole API down: the phone still needs localhost/Tailscale. Degrade
      // to no-LAN and surface the reason; only a localhost failure is fatal.
      lanBindError = error instanceof Error ? error.message : String(error)
      lanListener.closeAllConnections()
      await new Promise<void>((resolve) => lanListener.close(() => resolve()))
      lanServer = undefined
    }
  }
  return {
    port,
    lanError: lanBindError
      ? `LAN address ${lanAddress} is not active on this computer (${lanBindError}); local network access is off.`
      : undefined,
    httpServer: server,
    createPairing: (scope?: string) => {
      return pairing.create(scope)
    },
    events: sockets,
    setToken: (token: string) => {
      if (token.length < 32) throw new Error('The API token must have at least 32 characters.')
      currentToken = token
      pairing.cancel()
      for (const ws of sockets.clients) ws.terminate()
      for (const ws of voiceServer.clients) ws.terminate()
      server.closeAllConnections()
      lanServer?.closeAllConnections()
    },
    close: async () => {
      for (const ws of sockets.clients) ws.terminate()
      sockets.close()
      for (const ws of voiceServer.clients) ws.terminate()
      voiceServer.close()
      voiceEngine?.stop()
      server.closeAllConnections()
      lanServer?.closeAllConnections()
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        ...(lanServer ? [new Promise<void>((resolve) => lanServer.close(() => resolve()))] : []),
      ])
    },
  }
}
