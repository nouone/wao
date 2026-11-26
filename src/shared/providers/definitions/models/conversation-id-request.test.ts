// Proves the conversation cache key reaches the wire for a real custom
// (Lamina-style) provider: the field is top-level, message text is untouched,
// and the same session id rides every request in that chat.
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { CallChatCompletionOptions } from '@shared/models/types'
import type { ProviderModelInfo } from '@shared/types'
import type { ModelDependencies } from '@shared/types/adapters'
import type { SentryScope } from '@shared/utils/sentry_adapter'
import { describe, expect, it, vi } from 'vitest'
import { CONVERSATION_ID_FIELD } from '../../../models/utils/conversation-id'
import CustomOpenAI from './custom-openai'

type ChatModelHarness = {
  exposeChatModel(options: CallChatCompletionOptions): {
    doGenerate(options: LanguageModelV4CallOptions): Promise<unknown>
  }
}

function createDependencies(): ModelDependencies {
  return {
    request: { apiRequest: vi.fn(), fetchWithOptions: vi.fn() },
    storage: { saveImage: vi.fn(), getImage: vi.fn() },
    sentry: {
      captureException: vi.fn(),
      withScope: vi.fn((callback: (scope: SentryScope) => void) => callback({ setTag: vi.fn(), setExtra: vi.fn() })),
    },
    getRemoteConfig: vi.fn(),
    platformType: 'desktop',
  }
}

const info: ProviderModelInfo = { modelId: 'qwen3.8-flash-next-iq3_s', type: 'chat', apiStyle: 'openai' }

function modelWithCapturedBody(dependencies: ModelDependencies) {
  let body: Record<string, unknown> = {}
  dependencies.request.apiRequest = vi.fn((request) => {
    body = JSON.parse(String(request.body))
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'test',
          object: 'chat.completion',
          created: 0,
          model: info.modelId,
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    )
  })
  class TestModel extends CustomOpenAI {
    public exposeChatModel(options: CallChatCompletionOptions) {
      return this.getChatModel(options)
    }
  }
  const model = new TestModel({ apiKey: 'abc', apiHost: 'http://127.0.0.1:8080/v1', apiPath: '/chat/completions', model: info }, dependencies)
  return { model: model as unknown as ChatModelHarness, getBody: () => body }
}

async function send(model: ChatModelHarness, options: CallChatCompletionOptions, text: string) {
  await model.exposeChatModel(options).doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text }] }],
  } as LanguageModelV4CallOptions)
}

describe('conversation cache key on the wire', () => {
  it('sends lamina_conversation_id for the session on a custom compatible request', async () => {
    const { model, getBody } = modelWithCapturedBody(createDependencies())
    await send(model, { sessionId: '7f3a9c21-1111-2222-3333-444455556666', conversationCacheKey: true }, 'fix the spill naming')
    const body = getBody()
    expect(body[CONVERSATION_ID_FIELD]).toBe('7f3a9c21-1111-2222-3333-444455556666')
    expect(body.model).toBe('qwen3.8-flash-next-iq3_s')
    // the key must never be appended to the prompt: the wire messages are
    // exactly what the SDK would send without this feature (flattened text,
    // nothing added)
    expect(body.messages).toEqual([{ role: 'user', content: 'fix the spill naming' }])
  })

  it('keeps the same key across turns of one chat and switches it per chat', async () => {
    const dependencies = createDependencies()
    const { model, getBody } = modelWithCapturedBody(dependencies)
    await send(model, { sessionId: 'chat-a', conversationCacheKey: true }, 'first')
    const first = getBody()[CONVERSATION_ID_FIELD]
    await send(model, { sessionId: 'chat-a', conversationCacheKey: true }, 'second, after compaction')
    expect(getBody()[CONVERSATION_ID_FIELD]).toBe(first)
    await send(model, { sessionId: 'chat-b', conversationCacheKey: true }, 'unrelated chat')
    expect(getBody()[CONVERSATION_ID_FIELD]).toBe('chat-b')
  })

  it('sends no key for side tasks that name a session but send a different prompt', async () => {
    // Compaction summaries, auto-naming and OCR all pass sessionId for their
    // own purposes. If they carried the cache key, the engine would replace
    // the chat's snapshot with that unrelated prompt and the next real turn
    // would re-prefill from zero - the exact cost this feature removes.
    const { model, getBody } = modelWithCapturedBody(createDependencies())
    await send(model, { sessionId: 'chat-a' }, 'Summarize the conversation above...')
    expect(getBody()).not.toHaveProperty(CONVERSATION_ID_FIELD)
    await send(model, { sessionId: undefined }, 'hi')
    expect(getBody()).not.toHaveProperty(CONVERSATION_ID_FIELD)
  })
})
