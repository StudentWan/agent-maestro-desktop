import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerMessagesRoute, type ClaudeMessagesServices } from '../routes/messages'
import { createRequestLogger } from '../../../proxy/middleware/request-logger'
import { CopilotUpstreamError } from '../../../copilot/upstream-error'

function makeServices(overrides: Partial<{
  anthropicMessages: ReturnType<typeof vi.fn>
  anthropicMessagesStream: ReturnType<typeof vi.fn>
  chatCompletion: ReturnType<typeof vi.fn>
  chatCompletionStream: ReturnType<typeof vi.fn>
}>): ClaudeMessagesServices {
  return {
    anthropic: {
      messages: overrides.anthropicMessages ?? vi.fn(),
      messagesStream: overrides.anthropicMessagesStream ?? vi.fn(),
    } as any,
    chat: {
      chatCompletion: overrides.chatCompletion ?? vi.fn(),
      chatCompletionStream: overrides.chatCompletionStream ?? vi.fn(),
    } as any,
  }
}

describe('claude messages route', () => {
  it('returns 401 when services are not available', async () => {
    const app = new Hono()
    registerMessagesRoute(app, () => null)

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      }),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.type).toBe('authentication_error')
  })

  it('returns 400 for invalid JSON body', async () => {
    const app = new Hono()
    registerMessagesRoute(app, () => makeServices({}))

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('handles non-streaming request successfully', async () => {
    const anthropicMessages = vi.fn().mockResolvedValue({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Hello!' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const app = new Hono()
    registerMessagesRoute(app, () => makeServices({ anthropicMessages }))

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe('message')
    expect(body.role).toBe('assistant')
    expect(body.model).toBe('claude-sonnet-4-6')
    expect(body.content[0].text).toBe('Hello!')
    expect(anthropicMessages).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
      { anthropicBeta: undefined },
    )
  })

  it('logs xhigh from Claude Code xhigh thinking budget', async () => {
    const logCallback = vi.fn()
    const anthropicMessages = vi.fn().mockResolvedValue({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.7-1m-internal',
      content: [{ type: 'text', text: 'Hello!' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const app = new Hono()
    app.use('*', createRequestLogger(logCallback))
    registerMessagesRoute(app, () => makeServices({ anthropicMessages }))

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.7-1m-internal',
        thinking: { type: 'enabled', budget_tokens: 31999 },
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      }),
    })

    expect(res.status).toBe(200)
    expect(logCallback).toHaveBeenCalledTimes(1)
    expect(logCallback.mock.calls[0][0].thinkingLevel).toBe('xhigh')
  })

  it('returns 502 when copilot API throws', async () => {
    const anthropicMessages = vi.fn().mockRejectedValue(new Error('Network error'))

    const app = new Hono()
    registerMessagesRoute(app, () => makeServices({ anthropicMessages }))

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      }),
    })

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.type).toBe('api_error')
    expect(body.error.message).toContain('Network error')
  })

  it('returns 502 when streaming response has no body', async () => {
    const anthropicMessagesStream = vi.fn().mockResolvedValue({ body: null })

    const app = new Hono()
    registerMessagesRoute(app, () => makeServices({ anthropicMessagesStream }))

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
        stream: true,
      }),
    })

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.message).toContain('No response body')
  })

  it('keeps non-Claude requests on the OpenAI-compatible fallback path', async () => {
    const chatCompletion = vi.fn().mockResolvedValue({
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4.1',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello from GPT!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })

    const app = new Hono()
    registerMessagesRoute(app, () => makeServices({ chatCompletion }))

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content[0].text).toBe('Hello from GPT!')
    expect(chatCompletion).toHaveBeenCalled()
  })

  it('surfaces the upstream response body on the request log entry when copilot returns non-200', async () => {
    const logCallback = vi.fn()
    const upstreamBody = '{"error":{"type":"upstream_unavailable","message":"bad gateway"}}'
    const anthropicMessages = vi.fn().mockRejectedValue(
      new CopilotUpstreamError(
        'Copilot Anthropic Messages error (502)',
        502,
        upstreamBody,
      ),
    )

    const app = new Hono()
    app.use('*', createRequestLogger(logCallback))
    registerMessagesRoute(app, () => makeServices({ anthropicMessages }))

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      }),
    })

    expect(res.status).toBe(502)
    expect(logCallback).toHaveBeenCalledTimes(1)
    const entry = logCallback.mock.calls[0][0]
    expect(entry.upstreamError).toEqual({ status: 502, body: upstreamBody })
    expect(entry.error).toContain('Copilot Anthropic Messages error (502)')
  })
})
