// Stable conversation identity for OpenAI-compatible request bodies.
//
// Engines that keep a per-conversation prompt cache (Lamina) need a key that
// outlives the request: the same value must ride every send in a chat's life,
// so the cache is reused after compaction, editing, renaming or an app
// restart instead of the chat looking new and re-prefilling from token zero.
//
// Rules this implements (field spec, 2026-11-25):
//   - value is the session id Wao already persists - never derived from
//     message content, never regenerated, never a fresh uuid per turn
//   - absent (not empty) when there is no session id: an empty string would
//     push the engine onto its hash-of-first-message fallback, which is
//     exactly the instability this field exists to remove
//   - the field is added at the top level of the JSON body only; message
//     text is never touched
//   - an existing value is never overwritten (a caller that set one wins)
export const CONVERSATION_ID_FIELD = 'lamina_conversation_id'

export function withConversationId<T extends Record<string, unknown>>(
  body: T,
  sessionId: string | undefined
): T {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id) return body
  if (typeof body[CONVERSATION_ID_FIELD] === 'string' && body[CONVERSATION_ID_FIELD]) return body
  return { ...body, [CONVERSATION_ID_FIELD]: id }
}
