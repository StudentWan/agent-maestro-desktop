import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { registerHealthRoutes } from '../routes/health'

describe('health route', () => {
  it('returns status ok with timestamp', async () => {
    const app = new Hono()
    registerHealthRoutes(app)

    const res = await app.request('/health')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.timestamp).toBeDefined()
    expect(typeof body.timestamp).toBe('number')
  })
})
