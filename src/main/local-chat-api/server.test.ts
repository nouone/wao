import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { startLocalChatApi } from './server'
const token = 'test-only-token-'.repeat(4)
const running: Awaited<ReturnType<typeof startLocalChatApi>>[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const server of running.splice(0)) await server.close()
})
async function setup(extra: { publicOrigin?: string } = {}) {
  const dispatch = vi.fn().mockResolvedValue({ status: 200, body: { items: [] } })
  const server = await startLocalChatApi({ port: 0, token, dispatch, ...extra })
  running.push(server)
  const request = (
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string; auth?: boolean } = {}
  ) =>
    new Promise<{ status: number; body: string; headers: Record<string, string> }>((resolve) => {
      const req = Readable.from(options.body ? [Buffer.from(options.body)] : []) as IncomingMessage
      Object.assign(req, {
        url,
        method: options.method || 'GET',
        headers: {
          host: '127.0.0.1:' + server.port,
          ...(options.auth === false ? {} : { authorization: 'Bearer ' + token }),
          ...options.headers,
        },
      })
      let status = 0
      let headers = {}
      const res = {
        headersSent: false,
        setHeader: (name: string, value: string) => {
          headers = { ...headers, [name]: value }
        },
        writeHead: (s: number, h: Record<string, string>) => {
          status = s
          headers = { ...headers, ...h }
          res.headersSent = true
        },
        end: (body: string) => resolve({ status, body, headers }),
      }
      server.httpServer.emit('request', req, res as unknown as ServerResponse)
    })
  return { server, dispatch, request }
}
it('rejects missing credentials, hostile origins and Host headers before dispatch', async () => {
  const { request, dispatch } = await setup()
  expect((await request('/api/chats', { auth: false })).status).toBe(401)
  expect((await request('/api/chats', { headers: { origin: 'https://hostile.example' } })).status).toBe(403)
  expect((await request('/api/chats', { headers: { host: 'hostile.example' } })).status).toBe(403)
  expect(dispatch).not.toHaveBeenCalled()
})

it('pairs a Tailscale browser once, authenticates HTTP and WebSocket by HttpOnly cookie, and revokes on rotation', async () => {
  const origin = 'https://pc.example.ts.net:8443'
  const { request, server } = await setup({ publicOrigin: origin })
  const code = server.createPairing().code
  const headers = { host: 'pc.example.ts.net:8443', origin, 'content-type': 'application/json' }
  const paired = await request('/api/pair', {
    method: 'POST',
    auth: false,
    headers,
    body: JSON.stringify({ code, remember: true }),
  })
  expect(paired.status).toBe(200)
  expect(paired.headers['Set-Cookie']).toContain('HttpOnly; SameSite=Strict; Secure')
  const cookie = paired.headers['Set-Cookie'].split(';')[0]
  expect((await request('/api/chats', { auth: false, headers: { ...headers, cookie } })).status).toBe(200)
  expect(
    (await request('/api/pair', { method: 'POST', auth: false, headers, body: JSON.stringify({ code }) })).status
  ).toBe(401)
  expect(
    (await request('/api/chats', { auth: false, headers: { ...headers, cookie, origin: 'https://hostile.example' } }))
      .status
  ).toBe(403)
  expect((await request('/api/chats', { headers: { ...headers, 'tailscale-funnel-request': '?1' } })).status).toBe(403)
  const upgrade = vi.spyOn(server.events, 'handleUpgrade').mockImplementation(() => undefined)
  server.httpServer.emit(
    'upgrade',
    { url: '/api/events', headers: { ...headers, cookie, 'sec-websocket-protocol': 'wao-api' } },
    { end: vi.fn() },
    Buffer.alloc(0)
  )
  expect(upgrade).toHaveBeenCalledOnce()
  server.setToken('new-root'.repeat(8))
  expect((await request('/api/chats', { auth: false, headers: { ...headers, cookie } })).status).toBe(401)
})

it('identifies Wao without credentials and revokes old HTTP and WebSocket tokens on rotation', async () => {
  const { request, server, dispatch } = await setup()
  const identity = await request('/api/status', { auth: false })
  expect(JSON.parse(identity.body)).toEqual({ app: 'wao', apiVersion: 1 })
  const newToken = 'new-credential'.repeat(4)
  const disconnected = { terminate: vi.fn() }
  server.events.clients.add(disconnected as never)
  server.setToken(newToken)
  expect(disconnected.terminate).toHaveBeenCalledOnce()
  server.events.clients.delete(disconnected as never)
  expect((await request('/api/chats')).status).toBe(401)
  expect((await request('/api/chats', { headers: { authorization: 'Bearer ' + newToken } })).status).toBe(200)
  const end = vi.fn()
  server.httpServer.emit(
    'upgrade',
    { url: '/api/events', headers: { host: '127.0.0.1:' + server.port, authorization: 'Bearer ' + token } },
    { end },
    Buffer.alloc(0)
  )
  expect(end).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'))
  expect(dispatch).toHaveBeenCalledOnce()
})
it('routes list/history/send to the same renderer boundary', async () => {
  const { request, dispatch } = await setup()
  await request('/api/chats?limit=20&cursor=2')
  expect(dispatch).toHaveBeenLastCalledWith({ action: 'list', limit: 20, cursor: '2' })
  await request('/api/chats/chat-id')
  expect(dispatch).toHaveBeenLastCalledWith({ action: 'read', limit: 50, chatId: 'chat-id' })
  dispatch.mockResolvedValueOnce({ status: 202, body: { status: 'accepted' } })
  const response = await request('/api/chats/chat-id/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'my question' }),
  })
  expect(response.status).toBe(202)
  expect(dispatch).toHaveBeenLastCalledWith({ action: 'send', chatId: 'chat-id', content: 'my question', limit: 50 })
})
it('carries a valid thinkingEffort and rejects an unknown one', async () => {
  const { request, dispatch } = await setup()
  dispatch.mockResolvedValue({ status: 202, body: { status: 'accepted' } })
  const response = await request('/api/chats/chat-id/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'continue', thinkingEffort: 'off' }),
  })
  expect(response.status).toBe(202)
  expect(dispatch).toHaveBeenLastCalledWith({
    action: 'send',
    chatId: 'chat-id',
    content: 'continue',
    thinkingEffort: 'off',
    limit: 50,
  })
  const bad = await request('/api/chats/chat-id/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'continue', thinkingEffort: 'ultra' }),
  })
  expect(bad.status).toBe(400)
  expect(dispatch).toHaveBeenCalledTimes(1)
})
it('carries voice: true on mic-mode sends and omits it otherwise', async () => {
  const { request, dispatch } = await setup()
  dispatch.mockResolvedValue({ status: 202, body: { status: 'accepted' } })
  const voiced = await request('/api/chats/chat-id/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'what time is it', voice: true }),
  })
  expect(voiced.status).toBe(202)
  expect(dispatch).toHaveBeenLastCalledWith({
    action: 'send',
    chatId: 'chat-id',
    content: 'what time is it',
    voice: true,
    limit: 50,
  })
  await request('/api/chats/chat-id/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'typed text' }),
  })
  expect(dispatch).toHaveBeenLastCalledWith({
    action: 'send',
    chatId: 'chat-id',
    content: 'typed text',
    limit: 50,
  })
})
it('carries image attachments through to the renderer and allows image-only sends', async () => {
  const { request, dispatch } = await setup()
  dispatch.mockResolvedValue({ status: 202, body: { status: 'accepted' } })
  const withImage = await request('/api/chats/chat-id/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'what is this?', image: { data: 'iVBORw0KGgoBAgMEBQY=', mime: 'image/png' } }),
  })
  expect(withImage.status).toBe(202)
  expect(dispatch).toHaveBeenLastCalledWith({
    action: 'send',
    chatId: 'chat-id',
    content: 'what is this?',
    image: { data: 'iVBORw0KGgoBAgMEBQY=', mime: 'image/png' },
    limit: 50,
  })
  // no text at all: accepted when a photo accompanies it
  const imageOnly = await request('/api/chats/chat-id/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '', image: { data: 'iVBORw0KGgoBAgMEBQY=', mime: 'image/png' } }),
  })
  expect(imageOnly.status).toBe(202)
  // malformed image objects are ignored (treated as a plain text send)
  await request('/api/chats/chat-id/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'text', image: { data: 42, mime: 'image/png' } }),
  })
  expect(dispatch).toHaveBeenLastCalledWith({ action: 'send', chatId: 'chat-id', content: 'text', limit: 50 })
})
it('routes voice frontend calls (asr audio, speak text, note mirror) and validates payloads', async () => {
  const { request, dispatch } = await setup()
  dispatch.mockResolvedValue({ status: 200, body: { text: 'hello' } })
  const asr = await request('/api/voice/asr', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio: 'AAAA' }),
  })
  expect(asr.status).toBe(200)
  expect(dispatch).toHaveBeenLastCalledWith({ action: 'asr', content: 'AAAA', limit: 50 })
  const badAudio = await request('/api/voice/asr', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio: 42 }),
  })
  expect(badAudio.status).toBe(400)
  dispatch.mockResolvedValue({ status: 200, body: { audioBase64: 'eA==', contentType: 'audio/mpeg' } })
  const speak = await request('/api/voice/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'One sentence.' }),
  })
  expect(speak.status).toBe(200)
  expect(dispatch).toHaveBeenLastCalledWith({ action: 'speak', content: 'One sentence.', limit: 50 })
  dispatch.mockResolvedValue({ status: 200, body: { ok: true } })
  const note = await request('/api/voice/note', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msg: 'voice on, floor 0.0120' }),
  })
  expect(note.status).toBe(200)
  expect(dispatch).toHaveBeenLastCalledWith({ action: 'voice-note', content: 'voice on, floor 0.0120', limit: 50 })
})
it('validates JSON, text, body size and pagination before invoking desktop', async () => {
  const { request, dispatch } = await setup()
  for (const body of ['{broken', '{}', '{"content":" "}', JSON.stringify({ content: 'x'.repeat(60001) })])
    expect(
      (
        await request('/api/chats/id/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      ).status
    ).toBe(400)
  expect(
    (
      await request('/api/chats/id/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // messages POST carries optional base64 image attachments, so its
        // ceiling is 10 MB (every other route keeps 64 KB): oversized means
        // over 10 MB here.
        body: 'x'.repeat(11 * 1024 * 1024),
      })
    ).status
  ).toBe(413)
  expect((await request('/api/chats?limit=0')).status).toBe(400)
  expect(dispatch).not.toHaveBeenCalled()
})
it('routes stop and steer posts for a conversation to the renderer boundary', async () => {
  const { request, dispatch } = await setup()
  dispatch.mockResolvedValue({ status: 200, body: { stopped: true } })
  expect((await request('/api/chats/chat-id/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200)
  expect(dispatch).toHaveBeenLastCalledWith({ action: 'stop', chatId: 'chat-id', limit: 50 })
  dispatch.mockResolvedValue({ status: 200, body: { steered: true } })
  expect((await request('/api/chats/chat-id/steer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200)
  expect(dispatch).toHaveBeenLastCalledWith({ action: 'steer', chatId: 'chat-id', limit: 50 })
  expect((await request('/api/chats/chat-id/stop', { method: 'POST', auth: false })).status).toBe(401)
})
it('serves the voice worklet same-origin with a script-safe CSP and strict page headers', async () => {
  const { request } = await setup()
  const worklet = await request('/api/voice/worklet.js', { auth: false })
  expect(worklet.status).toBe(200)
  expect(worklet.headers['Content-Type']).toContain('text/javascript')
  // The whole point: WebKit enforces CSP on audioWorklet.addModule, and the
  // page's script-src 'unsafe-inline' rejects data: modules. The file must
  // carry no script-src of its own that could block it, and must define the
  // processor name the page requests.
  expect(worklet.headers['Content-Security-Policy']).not.toMatch(/script-src/)
  expect(worklet.body).toContain("registerProcessor('wao-capture'")
  const page = await request('/', { auth: false })
  expect(page.headers['Content-Security-Policy']).toContain("script-src 'self' 'unsafe-inline'")
  // WebKit enforces the document script-src on audioWorklet.addModule: 'self'
  // must be present or the worklet load dies with SecurityError (field #21).
  expect(page.headers['Content-Security-Policy']).toMatch(/script-src[^;]*\bself\b/)
  expect(page.body).toContain("addModule('/api/voice/worklet.js')")
})
it('serves a standalone browser page with no embedded token or external script', async () => {
  const { request } = await setup()
  const r = await request('/', { auth: false })
  expect(r.status).toBe(200)
  expect(r.body).toContain('Lumina Chat Web')
  expect(r.body).not.toContain(token)
  expect(r.body).not.toMatch(/<script[^>]+src=/)
  expect(r.headers['Content-Security-Policy']).toContain("connect-src 'self'")
})
it('rejects WebSocket upgrades without authentication', async () => {
  const { server, dispatch } = await setup()
  const end = vi.fn()
  server.httpServer.emit(
    'upgrade',
    { url: '/api/events', headers: { host: '127.0.0.1:' + server.port } },
    { end },
    Buffer.alloc(0)
  )
  expect(end).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'))
  expect(dispatch).not.toHaveBeenCalled()
})
it('publishes snapshots from the renderer repository on authenticated subscriptions', async () => {
  const { server, dispatch } = await setup()
  vi.useFakeTimers()
  dispatch.mockResolvedValue({
    status: 200,
    body: { id: 'desktop-chat', messages: [{ role: 'assistant', text: 'partial reply' }] },
  })
  const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() })
  server.events.emit('connection', socket)
  socket.emit('message', JSON.stringify({ type: 'subscribe', chatId: 'desktop-chat' }))
  await vi.advanceTimersByTimeAsync(250)
  expect(dispatch).toHaveBeenCalledWith({ action: 'read', chatId: 'desktop-chat', limit: 100 })
  expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
    type: 'chat.snapshot',
    chat: { id: 'desktop-chat' },
  })
  socket.emit('close')
})

it('pushes the live conversation list on the same subscription (~2s cadence)', async () => {
  const { server, dispatch } = await setup()
  vi.useFakeTimers()
  dispatch.mockImplementation(async (call: { action: string }) =>
    call.action === 'list'
      ? { status: 200, body: { items: [{ id: 'a', name: 'Renamed on Desktop', type: 'chat', generating: true }] } }
      : { status: 200, body: { id: 'a', messages: [] } }
  )
  const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() })
  server.events.emit('connection', socket)
  socket.emit('message', JSON.stringify({ type: 'subscribe', chatId: 'a' }))
  await vi.advanceTimersByTimeAsync(2000)
  const listMessages = socket.send.mock.calls
    .map(([frame]) => JSON.parse(frame))
    .filter((frame) => frame.type === 'chat.list')
  expect(listMessages.length).toBeGreaterThanOrEqual(1)
  expect(listMessages[0].chats).toEqual([{ id: 'a', name: 'Renamed on Desktop', type: 'chat', generating: true }])
  // Unchanged lists are not re-sent: no duplicate frames after the first.
  await vi.advanceTimersByTimeAsync(2000)
  expect(socket.send.mock.calls.map(([frame]) => JSON.parse(frame)).filter((f) => f.type === 'chat.list')).toHaveLength(1)
  socket.emit('close')
})

it('authenticates reply speech and returns only audio bytes with no-store headers', async () => {
  const {request,dispatch} = await setup()
  const options = {method:'POST',headers:{'content-type':'application/json'},body:'{}'}
  expect((await request('/api/chats/chat/messages/reply/speech',{...options,auth:false})).status).toBe(401)
  expect(dispatch).not.toHaveBeenCalled()
  dispatch.mockResolvedValue({status:200,body:{audioBase64:Buffer.from('audio').toString('base64'),contentType:'audio/mpeg'}})
  const response = await request('/api/chats/chat/messages/reply/speech',options)
  expect(response.status).toBe(200)
  expect(Buffer.from(response.body).toString()).toBe('audio')
  expect(response.headers['Content-Type']).toBe('audio/mpeg')
  expect(response.headers['Cache-Control']).toBe('no-store')
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({action:'speech',chatId:'chat',messageId:'reply'}))
})
