import { beforeEach, describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerModelsRoutes } from '../routes/models'
import type { TokenManager } from '../../../copilot/token-manager'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function createFetchResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

describe('models route', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

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

  it('includes current Claude model ids', async () => {
    const app = new Hono()
    registerModelsRoutes(app)

    const res = await app.request('/v1/models')
    const body = await res.json()
    const ids = body.data.map((m: any) => m.id)

    expect(ids).toContain('claude-opus-4.8')
    expect(ids).toContain('claude-opus-4-6')
    expect(ids).toContain('claude-sonnet-4-6')
    expect(ids).toContain('claude-haiku-4-5-20251001')
  })

  it('includes 1M context model variants', async () => {
    const app = new Hono()
    registerModelsRoutes(app)

    const res = await app.request('/v1/models')
    const body = await res.json()
    const ids = body.data.map((m: any) => m.id)

    expect(ids).toContain('claude-opus-4-6-1m')
    expect(ids).not.toContain('claude-sonnet-4-6-1m')
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

  it('uses authenticated Copilot model discovery when available', async () => {
    const app = new Hono()
    const tokenManager = {
      getTokenBundle: vi.fn().mockResolvedValue({
        token: 'jwt-copilot-token',
        expiresAt: Math.floor(Date.now() / 1000) + 1800,
        baseUrl: 'https://api.individual.githubcopilot.com',
      }),
    } as unknown as TokenManager
    registerModelsRoutes(app, () => tokenManager)

    mockFetch.mockResolvedValueOnce(createFetchResponse({
      data: [
        { id: 'claude-opus-5.0', name: 'Claude Opus 5.0', version: 'claude-opus-5.0' },
        { id: 'gpt-5.5', name: 'GPT 5.5', version: 'gpt-5.5' },
      ],
    }))

    const res = await app.request('/v1/models')
    const body = await res.json()
    const ids = body.data.map((m: any) => m.id)

    expect(ids).toEqual(['claude-opus-5.0'])
  })
})
