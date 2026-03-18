import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerMessagesRoute } from '../routes/anthropic-messages'

describe('anthropic messages route', () => {
  it('returns 401 when no copilot client is set', async () => {
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
    const mockClient = {} as any
    const app = new Hono()
    registerMessagesRoute(app, () => mockClient)

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
    const mockClient = {
      chatCompletion: vi.fn().mockResolvedValue({
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4.1',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    }

    const app = new Hono()
    registerMessagesRoute(app, () => mockClient as any)

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
  })

  it('returns 502 when copilot API throws', async () => {
    const mockClient = {
      chatCompletion: vi.fn().mockRejectedValue(new Error('Network error')),
    }

    const app = new Hono()
    registerMessagesRoute(app, () => mockClient as any)

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
    const mockClient = {
      chatCompletionStream: vi.fn().mockResolvedValue({ body: null }),
    }

    const app = new Hono()
    registerMessagesRoute(app, () => mockClient as any)

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
})
