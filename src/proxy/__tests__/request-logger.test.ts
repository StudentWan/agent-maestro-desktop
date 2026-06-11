import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createRequestLogger } from '../middleware/request-logger'

describe('request-logger middleware', () => {
  it('logs request details after response', async () => {
    const logCallback = vi.fn()
    const app = new Hono()

    app.use('*', createRequestLogger(logCallback))
    app.get('/test', (c) => c.json({ ok: true }))

    await app.request('/test')

    expect(logCallback).toHaveBeenCalledTimes(1)
    const entry = logCallback.mock.calls[0][0]
    expect(entry.method).toBe('GET')
    expect(entry.path).toBe('/test')
    expect(entry.status).toBe(200)
    expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    expect(entry.id).toMatch(/^req_/)
  })

  it('logs correct status for error responses', async () => {
    const logCallback = vi.fn()
    const app = new Hono()

    app.use('*', createRequestLogger(logCallback))
    app.get('/error', (c) => c.json({ error: 'not found' }, 404))

    await app.request('/error')

    const entry = logCallback.mock.calls[0][0]
    expect(entry.status).toBe(404)
  })

  it('detects SSE stream requests from Accept header', async () => {
    const logCallback = vi.fn()
    const app = new Hono()

    app.use('*', createRequestLogger(logCallback))
    app.post('/stream', (c) => c.json({ ok: true }))

    await app.request('/stream', {
      method: 'POST',
      headers: { 'Accept': 'text/event-stream' },
    })

    const entry = logCallback.mock.calls[0][0]
    expect(entry.stream).toBe(true)
  })

  it('sets stream to false when Accept does not contain SSE', async () => {
    const logCallback = vi.fn()
    const app = new Hono()

    app.use('*', createRequestLogger(logCallback))
    app.get('/normal', (c) => c.json({ ok: true }))

    await app.request('/normal')

    const entry = logCallback.mock.calls[0][0]
    expect(entry.stream).toBe(false)
  })

  it('increments request id across calls', async () => {
    const logCallback = vi.fn()
    const app = new Hono()

    app.use('*', createRequestLogger(logCallback))
    app.get('/a', (c) => c.json({ ok: true }))
    app.get('/b', (c) => c.json({ ok: true }))

    await app.request('/a')
    await app.request('/b')

    const id1 = logCallback.mock.calls[0][0].id
    const id2 = logCallback.mock.calls[1][0].id
    expect(id1).not.toBe(id2)
  })

  it('skips Claude Code root HEAD probes', async () => {
    const logCallback = vi.fn()
    const app = new Hono()

    app.use('*', createRequestLogger(logCallback))
    app.all('/', (c) => {
      if (c.req.method !== 'HEAD') {
        return c.notFound()
      }

      return new Response(null, { status: 204 })
    })

    const res = await app.request('/', { method: 'HEAD' })

    expect(res.status).toBe(204)
    expect(logCallback).not.toHaveBeenCalled()
  })

  it('reports model from c.set("loggedModel") instead of "unknown"', async () => {
    const logCallback = vi.fn()
    const app = new Hono()

    app.use('*', createRequestLogger(logCallback))
    app.post('/v1/messages', (c) => {
      c.set('loggedModel', 'claude-sonnet-4-5')
      c.set('loggedStream', true)
      return c.json({ ok: true })
    })

    await app.request('/v1/messages', { method: 'POST' })

    const entry = logCallback.mock.calls[0][0]
    expect(entry.model).toBe('claude-sonnet-4-5')
    expect(entry.stream).toBe(true)
  })

  it('reports input/output tokens and error message when set on context', async () => {
    const logCallback = vi.fn()
    const app = new Hono()

    app.use('*', createRequestLogger(logCallback))
    app.post('/v1/messages', (c) => {
      c.set('loggedModel', 'claude-haiku-4')
      c.set('loggedInputTokens', 1234)
      c.set('loggedOutputTokens', 56)
      c.set('loggedThinkingLevel', 'xhigh')
      c.set('loggedError', 'context_length_exceeded')
      return c.json({ ok: true })
    })

    await app.request('/v1/messages', { method: 'POST' })

    const entry = logCallback.mock.calls[0][0]
    expect(entry.inputTokens).toBe(1234)
    expect(entry.outputTokens).toBe(56)
    expect(entry.thinkingLevel).toBe('xhigh')
    expect(entry.error).toBe('context_length_exceeded')
  })

  it('falls back to request method and path when route does not set loggedModel', async () => {
    const logCallback = vi.fn()
    const app = new Hono()

    app.use('*', createRequestLogger(logCallback))
    app.get('/health', (c) => c.json({ ok: true }))

    await app.request('/health')

    const entry = logCallback.mock.calls[0][0]
    expect(entry.model).toBe('GET /health')
  })

  it('forwards loggedUpstreamError onto the log entry', async () => {
    const logCallback = vi.fn()
    const app = new Hono()

    app.use('*', createRequestLogger(logCallback))
    app.post('/v1/messages', (c) => {
      c.set('loggedModel', 'claude-sonnet-4-6')
      c.set('loggedError', 'Copilot Anthropic Messages error (502): bad gateway')
      c.set('loggedUpstreamError', { status: 502, body: 'bad gateway' })
      return c.json({ error: 'upstream failed' }, 502)
    })

    await app.request('/v1/messages', { method: 'POST' })

    const entry = logCallback.mock.calls[0][0]
    expect(entry.status).toBe(502)
    expect(entry.upstreamError).toEqual({ status: 502, body: 'bad gateway' })
    expect(entry.error).toBe('Copilot Anthropic Messages error (502): bad gateway')
  })
})
