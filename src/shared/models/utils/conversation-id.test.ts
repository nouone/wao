import { describe, expect, it } from 'vitest'
import { CONVERSATION_ID_FIELD, withConversationId } from './conversation-id'

const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'qwen3.8-flash-next-iq3_s',
  messages: [{ role: 'user', content: 'fix the spill naming' }],
  stream: true,
  ...extra,
})

describe('withConversationId', () => {
  it('adds the session id as a top-level field, leaving the body itself alone', () => {
    const input = body()
    const out = withConversationId(input, 'thread-7f3a9c21')
    expect(out[CONVERSATION_ID_FIELD]).toBe('thread-7f3a9c21')
    // the cache key must never leak into the prompt
    expect(out.messages).toEqual(input.messages)
    expect(input).not.toHaveProperty(CONVERSATION_ID_FIELD) // caller's object untouched
  })

  it('sends nothing when there is no session id (empty would force the engine onto a hash fallback)', () => {
    const input = body()
    expect(withConversationId(input, undefined)).toBe(input)
    expect(withConversationId(input, '')).toBe(input)
    expect(withConversationId(input, '   ')).toBe(input)
  })

  it('never overwrites an id already on the request', () => {
    const out = withConversationId({ [CONVERSATION_ID_FIELD]: 'caller-wins' }, 'session-1')
    expect(out[CONVERSATION_ID_FIELD]).toBe('caller-wins')
  })

  it('is stable for the same session and independent of content', () => {
    const a = withConversationId({ messages: ['first turn'] } as Record<string, unknown>, 'session-1')
    const b = withConversationId({ messages: ['first turn', 'compacted summary', 'later turn'] } as Record<string, unknown>, 'session-1')
    expect(a[CONVERSATION_ID_FIELD]).toBe(b[CONVERSATION_ID_FIELD])
    // a different session gets a different key
    expect(withConversationId({} as Record<string, unknown>, 'session-2')[CONVERSATION_ID_FIELD]).toBe('session-2')
  })
})
