import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchAvailableModels } from '../models'
import type { TokenManager } from '../token-manager'

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

describe('fetchAvailableModels', () => {
  let mockTokenManager: TokenManager

  beforeEach(() => {
    mockFetch.mockReset()
    mockTokenManager = {
      getToken: vi.fn().mockResolvedValue('jwt-token'),
    } as unknown as TokenManager
  })

  it('fetches and filters for Claude models only', async () => {
    const modelsData = {
      data: [
        { id: 'gpt-4.1', name: 'GPT-4.1', version: '1.0' },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', version: '1.0' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', version: '1.0' },
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', version: '1.0' },
      ],
    }

    mockFetch.mockResolvedValueOnce(createFetchResponse(modelsData))

    const models = await fetchAvailableModels(mockTokenManager)
    expect(models).toHaveLength(2)
    expect(models[0]).toEqual({ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' })
    expect(models[1]).toEqual({ id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' })
  })

  it('returns empty array when no Claude models found', async () => {
    const modelsData = {
      data: [
        { id: 'gpt-4.1', name: 'GPT-4.1', version: '1.0' },
      ],
    }

    mockFetch.mockResolvedValueOnce(createFetchResponse(modelsData))

    const models = await fetchAvailableModels(mockTokenManager)
    expect(models).toHaveLength(0)
  })

  it('uses model id as name when name is empty', async () => {
    const modelsData = {
      data: [
        { id: 'claude-opus-4-6', name: '', version: '1.0' },
      ],
    }

    mockFetch.mockResolvedValueOnce(createFetchResponse(modelsData))

    const models = await fetchAvailableModels(mockTokenManager)
    expect(models[0].name).toBe('claude-opus-4-6')
  })

  it('handles missing data field', async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse({}))

    const models = await fetchAvailableModels(mockTokenManager)
    expect(models).toHaveLength(0)
  })

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse('Forbidden', false, 403))

    await expect(fetchAvailableModels(mockTokenManager)).rejects.toThrow('Failed to fetch models')
  })

  it('sends proper headers', async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse({ data: [] }))

    await fetchAvailableModels(mockTokenManager)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer jwt-token',
          'Openai-Organization': 'github-copilot',
        }),
      }),
    )
  })
})
