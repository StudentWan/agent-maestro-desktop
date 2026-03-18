import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { registerModelsRoutes } from '../routes/models'

describe('models route', () => {
  it('returns a list of Claude models', async () => {
    const app = new Hono()
    registerModelsRoutes(app)

    const res = await app.request('/v1/models')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.object).toBe('list')
    expect(body.data).toBeInstanceOf(Array)
    expect(body.data.length).toBeGreaterThanOrEqual(3)
  })

  it('includes claude-opus-4-6 model', async () => {
    const app = new Hono()
    registerModelsRoutes(app)

    const res = await app.request('/v1/models')
    const body = await res.json()
    const ids = body.data.map((m: any) => m.id)

    expect(ids).toContain('claude-opus-4-6')
    expect(ids).toContain('claude-sonnet-4-6')
    expect(ids).toContain('claude-haiku-4-5-20251001')
  })

  it('each model has required fields', async () => {
    const app = new Hono()
    registerModelsRoutes(app)

    const res = await app.request('/v1/models')
    const body = await res.json()

    for (const model of body.data) {
      expect(model.id).toBeDefined()
      expect(model.object).toBe('model')
      expect(model.created).toBeDefined()
      expect(model.owned_by).toBe('anthropic')
    }
  })
})
