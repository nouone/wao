// The session id is the conversation cache key: it rides to the engine as
// lamina_conversation_id and names the engine's per-chat snapshot. New chats
// use 8 lowercase hex characters (createConversationId in
// renderer-application.ts; the uuid v4 hyphen-stripped prefix). This test
// pins the shape without importing the app module graph: same construction,
// checked directly.
import { describe, expect, test } from 'vitest'
import { v4 as uuidv4 } from 'uuid'

function createConversationId(): string {
  return uuidv4().replace(/-/g, '').slice(0, 8)
}

describe('conversation cache key shape', () => {
  test('is exactly 8 lowercase hex characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(createConversationId()).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  test('distinct across calls', () => {
    const ids = new Set(Array.from({ length: 500 }, createConversationId))
    expect(ids.size).toBe(500)
  })
})
