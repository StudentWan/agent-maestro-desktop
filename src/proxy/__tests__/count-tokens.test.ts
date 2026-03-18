import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { registerCountTokensRoute } from '../routes/anthropic-count-tokens'

describe('count tokens route', () => {
  it('returns estimated token count for valid JSON body', async () => {
    const app = new Hono()
    registerCountTokensRoute(app)

    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello world' }],
      max_tokens: 100,
    }

    const res = await app.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(res.status).toBe(200)
    const result = await res.json()
    expect(result.input_tokens).toBeDefined()
    expect(typeof result.input_tokens).toBe('number')
    expect(result.input_tokens).toBeGreaterThan(0)
  })

  it('estimates ~6 chars per token', async () => {
    const app = new Hono()
    registerCountTokensRoute(app)

    const body = { x: 'a'.repeat(100) }
    const bodyStr = JSON.stringify(body)
    const expectedTokens = Math.ceil(bodyStr.length / 6)

    const res = await app.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const result = await res.json()
    expect(result.input_tokens).toBe(expectedTokens)
  })

  it('returns 400 for invalid JSON', async () => {
    const app = new Hono()
    registerCountTokensRoute(app)

    const res = await app.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{{{',
    })

    expect(res.status).toBe(400)
    const result = await res.json()
    expect(result.error.type).toBe('invalid_request_error')
  })
})
