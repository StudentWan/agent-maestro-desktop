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
})
