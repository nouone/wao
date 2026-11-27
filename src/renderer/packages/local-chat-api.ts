import { getSessionActionGate } from '@chatbox/core/session/action-gates'
import { isActionAvailableInMode, resolveSessionMode } from '@chatbox/core/session/mode-policy'
import { getSessionLockStateNow } from '@/stores/session/action-guard'
import type { LocalChatCall, LocalChatResult } from '@shared/local-chat-api'
import { createMessage } from '@shared/types'
import { getMessageText } from '@shared/utils/message'
import { rendererApplication } from '@/app/renderer-application'
import { getLogger } from '@/lib/utils'
import { settingsStore } from '@/stores/settingsStore'
import { submitNewUserMessage } from '@/stores/session/messages'
import { isSessionGenerating } from '@/stores/sessionActivityStore'

const pendingChats = new Set<string>()
const errors = new Map<string, string>()

// Web image attachments: accepted types and their magic bytes. The mime
// allowlist alone is not enough - a caller could label a PDF as jpeg and the
// provider would reject the part with a far less actionable error than ours.
const WEB_IMAGE_MIMES: Record<string, boolean> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
  'image/gif': true,
}
function isImageMagic(bytes: Uint8Array, mime: string): boolean {
  const at = (o: number, ...vals: number[]) => vals.every((v, i) => bytes[o + i] === v)
  if (bytes.length < 12) return false
  switch (mime) {
    case 'image/png':
      return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    case 'image/jpeg':
      return at(0, 0xff, 0xd8, 0xff)
    case 'image/webp':
      return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)
    case 'image/gif':
      return at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
    default:
      return false
  }
}

// Field report: with the transcription service stopped, the phone read
// "Voice: Access is denied" - Electron's session fetch reports a refused
// local port as ERROR_ACCESS_DENIED on Windows (and "fetch failed" in the
// Node stack), so a dead service masquerades as a permissions problem.
// Translate connection-level failures into what the user can actually act
// on; genuine HTTP statuses keep their own message.
function voiceConnectionIssue(error: unknown, url: string, label: string): string | null {
  const detail = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return `${label} at ${url} did not answer in time. Try again in a moment.`
  }
  if (/access is denied|fetch failed|failed to fetch|networkerror|err_connection|err_failed|err_network|econnrefused|econnreset|enotfound/i.test(detail)) {
    return `${label} is not reachable at ${url}. Start the service, or fix its URL in Desktop Settings → Default Models.`
  }
  return null
}

// Mic-mode answer style (voice: true sends). The reply is only ever heard, so
// one generation pass produces speech-ready text - no separate rewrite stage.
// Stored as part of the user message: it rides the history, so every later
// turn in the voice thread stays speakable without client-side prompt copies.
export const VOICE_INSTRUCTION =
  'You are responding through a voice interface. Answer the request below in natural, conversational, speakable language.\n' +
  '- Answer the actual question; do not repeat or paraphrase it.\n' +
  '- Expand abbreviations as you go (say "November", not "Nov"); do not explain terms unless asked.\n' +
  '- Use complete natural sentences; turn lists and tables into brief spoken explanations.\n' +
  '- No markdown, no code blocks, no URLs, no visual formatting.\n' +
  '- Speak numbers, dates and units in words.\n' +
  '- Keep it brief: one to three short sentences unless the question needs more.\n' +
  '- Never announce what you are doing; ask a question back only when truly necessary.\n\n'

// First line of VOICE_INSTRUCTION, unique enough to identify voice-styled
// threads when scanning stored user messages (see the send handler).
const VOICE_MARKER = 'You are responding through a voice interface.'

// Pending desktop-queue items for the web read payload: text previews of
// not-yet-delivered entries. In-flight items are skipped - their text is
// already in the transcript as the live user message, and listing both
// would double the bubble on the page.
async function webQueueItems(chatId: string): Promise<{ id: string; text: string }[]> {
  try {
    const { messageQueueStore } = await import('@/stores/session/message-queue')
    const items = messageQueueStore.getState().queues[chatId] ?? []
    return items.flatMap((item) =>
      item.kind === 'message' && !item.inFlight ? [{ id: item.id, text: getMessageText(item.message) }] : []
    )
  } catch {
    return []
  }
}

async function voiceThreadHasInstruction(chatId: string): Promise<boolean> {
  try {
    const page = await rendererApplication.sessions.readSessionTranscriptWindow({
      sessionId: chatId,
      limit: 100,
      maxBytes: 2 * 1024 * 1024,
      origin: 'tail' as const,
    })
    return (page?.messages || []).some(
      ({ message }: { message: { role?: string; contentParts?: { type?: string; text?: string }[] } }) =>
        message.role === 'user' &&
        (message.contentParts || []).some((part) => part.type === 'text' && (part.text || '').includes(VOICE_MARKER))
    )
  } catch {
    // Unreadable thread: fall on the side of style - send the instruction.
    return false
  }
}

export async function handleLocalChatCall(call: LocalChatCall): Promise<LocalChatResult> {
  const sessions = rendererApplication.sessions
  try {
    if (call.action === 'create') {
      const { createEmpty } = await import('@/stores/session/crud')
      const session = await createEmpty('chat')
      return { status: 201, body: { id: session.id, name: session.name } }
    }
    if (call.action === 'list') {
      const offset = Number(call.cursor || 0)
      if (!Number.isInteger(offset) || offset < 0) return { status: 400, body: { error: 'Invalid chat list cursor' } }
      const page = await sessions.listSessionsMetaPage(offset, call.limit || 50)
      return {
        status: 200,
        body: {
          items: page.items
            .filter((s) => s.type === 'chat' || !s.type)
            .map((s) => ({
              id: s.id,
              name: s.name,
              type: s.type,
              // Live activity for the web chat list (field: the page could not
              // see which chats were generating; Desktop's sidebar can).
              generating: pendingChats.has(s.id) || isSessionGenerating(s.id),
              // Read-only folder grouping (field: the phone showed foldered
              // chats loose in one stream). Membership only; creating,
              // renaming and moving folders stays a Desktop operation.
              ...(s.folderId ? { folderId: s.folderId } : {}),
            })),
          folders: (await sessions.listSessionFolders()).map((folder) => ({ id: folder.id, name: folder.name })),
          nextCursor: page.nextCursor,
          total: page.total,
        },
      }
    }
    if (call.action === 'asr') {
      // Voice frontend audio (WAV bytes as base64) -> configured ASR server.
      // desktopDirectRequest bypass CORS like read-aloud does for Kokoro.
      const asrUrl = settingsStore.getState().getSettings().textToSpeech?.asrUrl?.trim()
      if (!asrUrl) return { status: 409, body: { error: 'Set a transcription server URL in Desktop Settings > Default Models first.' } }
      if (!call.content || call.content.length > 12 * 1024 * 1024) return { status: 400, body: { error: 'Invalid audio payload' } }
      const { desktopDirectRequestFromWindow } = await import('@/utils/desktop-direct-request')
      try {
        const binary = atob(call.content)
        const audio = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) audio[i] = binary.charCodeAt(i)
        const asrKey = settingsStore.getState().getSettings().textToSpeech?.asrKey?.trim()
        const response = await desktopDirectRequestFromWindow(
          asrUrl.replace(/\/+$/, '') + '/v1/audio/transcriptions/raw',
          'POST',
          new Headers({ 'Content-Type': 'audio/wav', ...(asrKey ? { Authorization: `Bearer ${asrKey}` } : {}) }),
          audio,
          AbortSignal.timeout(30000)
        )
        if (!response.ok) return { status: 502, body: { error: `Transcription server returned HTTP ${response.status}.` } }
        const parsed = (await response.json()) as { text?: unknown }
        if (typeof parsed.text !== 'string') return { status: 502, body: { error: 'Transcription server returned no text.' } }
        return { status: 200, body: { text: parsed.text.trim() } }
      } catch (error) {
        const issue = voiceConnectionIssue(error, asrUrl, 'Transcription service')
        if (issue) return { status: 502, body: { error: issue } }
        return { status: 502, body: { error: error instanceof Error ? error.message : 'Transcription failed.' } }
      }
    }
    if (call.action === 'speak') {
      // Voice frontend sentence pipelining: synthesize free text with the
      // configured read-aloud voice (same rewrite + normalization as replies).
      const text = typeof call.content === 'string' ? call.content.trim() : ''
      if (!text) return { status: 400, body: { error: 'content required' } }
      if (text.length > 4000) return { status: 400, body: { error: 'Sentence too long to speak in one request.' } }
      try {
        const { synthesizeSpeechText } = await import('./local-chat-speech')
        const blob = await synthesizeSpeechText(text, AbortSignal.timeout(60000))
        if (blob.size > 8 * 1024 * 1024) return { status: 502, body: { error: 'Speech audio exceeds the playback limit.' } }
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let encoded = ''
        for (let i = 0; i < bytes.length; i += 32768) encoded += String.fromCharCode(...bytes.subarray(i, i + 32768))
        return { status: 200, body: { audioBase64: btoa(encoded), contentType: blob.type || 'audio/mpeg' } }
      } catch (error) {
        const ttsUrl = settingsStore.getState().getSettings().textToSpeech?.apiBaseUrl?.trim() || 'the speech server'
        const issue = voiceConnectionIssue(error, ttsUrl, 'Speech service')
        if (issue) return { status: 502, body: { error: issue } }
        return { status: 502, body: { error: error instanceof Error ? error.message : 'Speech synthesis failed.' } }
      }
    }
    if (call.action === 'voice-note') {
      // Decision-mirror log lines from the voice frontend: one line per call,
      // prefixed voice: so field logs stay greppable from the desktop app.
      const msg = typeof call.content === 'string' ? call.content.slice(0, 200) : ''
      if (msg) getLogger('voice').info(`page: ${msg}`)
      return { status: 200, body: { ok: true } }
    }
    if (!call.chatId) return { status: 400, body: { error: 'chatId required' } }
    const source = await sessions.getSessionHeader(call.chatId)
    if (!source) return { status: 404, body: { error: 'Conversation not found' } }
    if (source.header.type && source.header.type !== 'chat')
      return { status: 400, body: { error: 'Only chat conversations are supported' } }
    if (call.action === 'speech') {
      if (!call.messageId || call.messageId.length > 200) return {status:400,body:{error:'messageId required'}}
      const result = await sessions.readSessionMessages({sessionId:call.chatId,messageIds:[call.messageId]})
      const message = result?.messages.find((item) => item.id === call.messageId)
      if (!message || message.role !== 'assistant') return {status:404,body:{error:'Assistant reply not found'}}
      if (message.generating || message.error) return {status:409,body:{error:'Wait for the reply to finish before reading'}}
      const { synthesizeWebReply } = await import('./local-chat-speech')
      return {status:200,body:await synthesizeWebReply(message, call.chatId)}
    }
    if (call.action === 'read') {
      const locks = await getSessionLockStateNow(call.chatId)
      let cursor
      try {
        cursor = call.cursor ? JSON.parse(call.cursor) : undefined
      } catch {
        return { status: 400, body: { error: 'Invalid history cursor' } }
      }
      const limit = Math.min(call.limit || 50, 100)
      const readChatId = call.chatId
      const readWindow = (revision: number, pageCursor = cursor) =>
        sessions.readSessionTranscriptWindow({
          sessionId: readChatId,
          expectedRevision: revision,
          limit,
          maxBytes: 2 * 1024 * 1024,
          ...(pageCursor ? { cursor: pageCursor } : { origin: 'tail' as const }),
        })
      let page
      try {
        page = await readWindow(cursor?.revision ?? source.revision)
      } catch (error) {
        // A cursor read races any new message: the page cursor pins the revision
        // it was cut at, and a desktop send bumps it. The cursor's anchor is a
        // message ID that still exists, so re-read once against the current
        // revision (cursor re-stamped; the reader requires cursor.revision to
        // equal expectedRevision) instead of failing "Conversation changed"
        // (field: load-older broke after every desktop send on long chats).
        // Non-cursor reads pass the fresh header revision and cannot race.
        if (!cursor) throw error
        const fresh = await sessions.getSessionHeader(call.chatId)
        if (!fresh || fresh.revision === cursor.revision) throw error
        page = await readWindow(fresh.revision, { ...cursor, revision: fresh.revision })
      }
      return {
        status: 200,
        body: {
          id: call.chatId,
          name: source.header.name,
          revision: source.revision,
          generating: pendingChats.has(call.chatId) || isSessionGenerating(call.chatId),
          // Web Steer affordance (field: the page offered Steer in plain chat
          // mode, where no step boundary exists to inject at). The same rule
          // the desktop queue bar uses: steering is a work-mode capability,
          // and the mode lives in the session settings the desktop persists.
          steerable: isActionAvailableInMode(
            'steer-queued-message',
            resolveSessionMode(source.header.settings?.agentMode?.value)
          ),
          // Desktop's queue, visible on the web page (field: injected
          // messages were invisible there): pending items only, as text.
          queued: await webQueueItems(call.chatId),
          waitingForApproval: locks?.awaitingPauseDecision || false,
          compacting: locks?.compactionRunning || false,
          error: errors.get(call.chatId),
          messages: (page?.messages || [])
            .map((row) => ({
              ...row,
              message:
                rendererApplication.generationRuntime.getLiveMessage(call.chatId!, row.message.id) || row.message,
            }))
            .filter(({ message }) => message.role !== 'system')
            .map(({ message, threadId }) => ({
              id: message.id,
              threadId,
              role: message.role,
              text: getMessageText(message, true, false),
              generating: message.generating,
              error: message.error,
              timestamp: message.timestamp,
              model: message.model,
              thinking: message.generating && message.contentParts?.some((part) => part.type === 'reasoning'),
              thinkingEffort: message.thinkingEffort,
              performance: {
                inputTokens: message.usage?.inputTokens,
                outputTokens: message.usage?.outputTokens,
                totalTokens: message.usage?.totalTokens,
                cachedTokens: message.usage?.cachedInputTokens,
                generationTokensPerSecond: message.usage?.engineOutputTokensPerSecond,
                processingTokensPerSecond: message.usage?.engineInputTokensPerSecond,
                processedTokens: message.usage?.engineProcessedTokens,
                decodeMs: message.usage?.engineDecodeMs,
                promptMs: message.usage?.enginePromptMs,
                durationMs: message.generationDuration,
                // Tool wall time vs model time (Nou: sleeps in commands were billed
                // to reply latency). toolMs = sum of tool-call part durations;
                // modelMs = generationDuration - toolMs, what the engine actually took.
                toolMs: (message.contentParts || []).reduce((sum: number, part: any) => (part.type === 'tool-call' && typeof part.duration === 'number' ? sum + part.duration : sum), 0) || undefined,
                modelMs: message.generationDuration ? Math.max(0, message.generationDuration - (message.contentParts || []).reduce((sum: number, part: any) => (part.type === 'tool-call' && typeof part.duration === 'number' ? sum + part.duration : sum), 0)) : undefined,
                // Same rule as the desktop message-token-display: the highest
                // content-part stepIndex + 1 is the number of engine requests
                // this reply took; only surfaced when it exceeds one step.
                stepCount: (message.contentParts || []).reduce(
                  (max, part) => ('stepIndex' in part && typeof part.stepIndex === 'number' ? Math.max(max, part.stepIndex + 1) : max),
                  0
                ) || undefined,
              },
              files: message.files?.map((f) => ({ name: f.name })),
            })),
          nextCursor: page?.older ? JSON.stringify(page.older) : null,
        },
      }
    }
    if (call.action === 'stop') {
      // Desktop's Stop button, remote: same cancellation controller
      // (generation-cancellation.stopAllMessageGenerations). Nothing running
      // is a no-op 200, so the page button never needs to race the snapshot.
      const active = pendingChats.has(call.chatId) || isSessionGenerating(call.chatId)
      if (active) pendingChats.delete(call.chatId)
      const { stopAllMessageGenerations } = await import('@/stores/session/generation-cancellation')
      await stopAllMessageGenerations(call.chatId)
      return { status: 200, body: { stopped: active } }
    }
    if (call.action === 'steer') {
      // Desktop's steering, remote: the first queued text-only message jumps
      // into the running generation at its next step boundary. Requires the
      // model to support steering (same isSteerableQueuedMessage check the
      // desktop queue uses); false is reported, not swallowed.
      const { requestSteerFirstQueuedMessage } = await import('@/stores/session/message-queue')
      const requested = requestSteerFirstQueuedMessage(call.chatId)
      return requested
        ? { status: 200, body: { steered: true } }
        : { status: 409, body: { error: 'No queue item can steer right now (model may not support steering).' } }
    }
    if (
      call.action !== 'send' ||
      typeof call.content !== 'string' ||
      call.content.length > 60000 ||
      (!call.content.trim() && !call.image)
    )
      return { status: 400, body: { error: 'Invalid message' } }
    // Desktop composer parity (field: "no way to inject or stop a desktop
    // session on mobile"): while a reply streams, a web send ENQUEUES behind
    // it through the same message-queue controller the desktop uses - the
    // item shows in Desktop's queue bar and drains in order. Only hard locks
    // (pending tool approval) still reject. The drain copies
    // suppressDesktopAutoRead to the assistant reply, so queued web turns
    // stay silent on Desktop like direct ones.
    const busyNow = pendingChats.has(call.chatId) || isSessionGenerating(call.chatId)
    const locks = await getSessionLockStateNow(call.chatId)
    if (!locks) return { status: 404, body: { error: 'Conversation not found' } }
    if (!busyNow) {
      const gate = getSessionActionGate('submit-message', locks)
      if (!gate.allowed) return { status: 409, body: { error: `Conversation blocked: ${gate.reason}` } }
    }
    // Phone image attachment: validate, then store the bytes in the same blob
    // store the desktop composer's images use (data-URL value), so the
    // message renders in Desktop and reaches the vision model unchanged. The
    // magic-byte check below is not paranoia: an image part with non-image
    // bytes reaches the provider and fails there with a worse error.
    let imageStorageKey: string | undefined
    if (call.image) {
      if (!WEB_IMAGE_MIMES[call.image.mime])
        return { status: 400, body: { error: 'Image type not supported (png, jpeg, webp or gif).' } }
      if (call.image.data.length > 9 * 1024 * 1024)
        return { status: 413, body: { error: 'Image too large (max 6 MB).' } }
      let bytes: Uint8Array
      try {
        const binary = atob(call.image.data)
        bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      } catch {
        return { status: 400, body: { error: 'Image data is not valid base64.' } }
      }
      if (!isImageMagic(bytes, call.image.mime))
        return { status: 400, body: { error: 'Image data does not match a real image file.' } }
      const { currentBlobStorage } = await import('@/adapters/CurrentBlobStorage')
      const { StorageKeyGenerator } = await import('@/storage/StoreStorage')
      imageStorageKey = StorageKeyGenerator.picture('web-input')
      const dataUrl = `data:${call.image.mime};base64,${call.image.data}`
      try {
        await currentBlobStorage.set(imageStorageKey, dataUrl)
      } catch (error) {
        return {
          status: 500,
          body: { error: `Could not store the image: ${error instanceof Error ? error.message : error}` },
        }
      }
    }
    const message = createMessage(
      'user',
      // Voice sends carry the speakable-answer instruction ONLY while the
      // thread lacks it (Nou: "once is enough"). The model obeys the style
      // from the first copy sitting in context; resending it every turn just
      // adds prompt weight. The check scans the stored tail: after history
      // compaction drops the instruction, the next voice send re-adds it.
      call.voice && (await voiceThreadHasInstruction(call.chatId))
        ? call.content
        : call.voice
          ? VOICE_INSTRUCTION + '\n\n' + call.content
          : call.content
    )
    message.suppressDesktopAutoRead = true
    if (imageStorageKey) {
      message.contentParts = message.contentParts ?? []
      message.contentParts.push({ type: 'image', storageKey: imageStorageKey })
    }
    const chatId = call.chatId
    if (call.thinkingEffort) {
      try {
        await applyThinkingEffort(chatId, call.thinkingEffort)
      } catch (error) {
        return {
          status: 500,
          body: { error: error instanceof Error ? `thinkingEffort failed: ${error.message}` : 'thinkingEffort could not be applied' },
        }
      }
    }
    if (busyNow) {
      // Queue, don't reject: the desktop message-queue controller persists the
      // item, shows it in Desktop's queue bar, and drains it in order (with
      // steering available meanwhile).
      const { enqueueUserMessage } = await import('@/stores/session/message-queue')
      const queued = enqueueUserMessage(chatId, message)
      if (queued === 'full') return { status: 429, body: { error: 'The message queue is full on Desktop.' } }
      if (queued === 'persist-failed') return { status: 500, body: { error: 'Could not store the queued message.' } }
      return { status: 202, body: { status: 'queued', chatId, messageId: message.id } }
    }
    pendingChats.add(chatId)
    errors.delete(chatId)
    // Exactly the controller used by routes/session/$sessionId.tsx's desktop Send handler.
    void submitNewUserMessage(chatId, { newUserMsg: message, needGenerating: true })
      .catch((error: unknown) => {
        errors.set(chatId, error instanceof Error ? error.message : 'Message processing failed')
      })
      .finally(() => {
        pendingChats.delete(chatId)
      })
    return { status: 202, body: { status: 'accepted', chatId, messageId: message.id } }
  } catch (error) {
    return {
      status: 409,
      body: { error: error instanceof Error ? error.message : 'Conversation changed; refresh and try again' },
    }
  }
}

export function initLocalChatApiBridge() {
  if (!window.electronAPI?.onLocalChatApiRequest) return
  return window.electronAPI.onLocalChatApiRequest(handleLocalChatCall)
}

// Persist the caller's per-send thinking level the same way the desktop
// Thinking Effort selector does: build the provider options for the
// conversation's model with the shared level helper (capability-gated, and
// off maps to the provider's explicit none), then write them into the
// session header settings where the generation service resolves them.
async function applyThinkingEffort(sessionId: string, level: 'off' | 'low' | 'medium' | 'high') {
  const { getReasoningProviderOptions, resolveReasoningProviderOptions, setReasoningProviderOptionsForModel } =
    await import('@shared/utils/reasoning-control')
  const { settingsStore } = await import('@/stores/settingsStore')
  await rendererApplication.sessions.updateSessionHeader(sessionId, (session) => {
    if (!session) throw new Error('Session not found')
    const settings = session.settings || {}
    const store = settingsStore.getState()
    const defaults = store.getSettings()
    const providerId = settings.provider || defaults.defaultChatModel?.provider
    const modelId = settings.modelId || defaults.defaultChatModel?.model
    if (!providerId || !modelId) throw new Error('No chat model is selected for this conversation')
    // Custom-provider lookup mirroring modals/ModelEdit.tsx (the surface where
    // the "Strata Thinking control" flag lives); a missing entry is not an
    // error: the capability check below then no-ops and the send proceeds.
    // Models sit on provider.models or provider.defaultSettings.models, the
    // same dual shape ReasoningControlButton accepts.
    const providerInfo = (store.customProviders || []).find((item) => item.id === providerId) as
      | { models?: { modelId: string }[]; defaultSettings?: { models?: { modelId: string }[] } }
      | undefined
    const modelList = providerInfo?.models || providerInfo?.defaultSettings?.models
    const modelInfo = modelList?.find((item) => item.modelId === modelId) || null
    const previous = resolveReasoningProviderOptions(settings, providerId, modelId)
    const next = getReasoningProviderOptions(providerId as never, modelInfo as never, level, previous)
    return {
      ...session,
      settings: {
        ...settings,
        ...setReasoningProviderOptionsForModel(settings, providerId, modelId, next),
      },
    }
  })
}
