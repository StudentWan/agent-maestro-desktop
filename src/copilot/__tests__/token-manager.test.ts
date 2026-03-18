import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TokenManager } from '../token-manager'

// Mock global fetch
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

describe('TokenManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initializes and fetches token', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 1800
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ token: 'jwt-token-123', expires_at: futureExpiry }),
    )

    const manager = new TokenManager('github-access-token')
    const token = await manager.initialize()

    expect(token.token).toBe('jwt-token-123')
    expect(token.expiresAt).toBe(futureExpiry)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    manager.dispose()
  })

  it('getToken returns cached token when not expired', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 1800
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ token: 'cached-token', expires_at: futureExpiry }),
    )

    const manager = new TokenManager('github-access-token')
    await manager.initialize()

    const token = await manager.getToken()
    expect(token).toBe('cached-token')
    // Should not have fetched again
    expect(mockFetch).toHaveBeenCalledTimes(1)

    manager.dispose()
  })

  it('getToken refreshes when token is expired', async () => {
    // First fetch: token already expired
    const pastExpiry = Math.floor(Date.now() / 1000) - 100
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ token: 'old-token', expires_at: pastExpiry }),
    )

    const manager = new TokenManager('github-access-token')
    await manager.initialize()

    // Second fetch: new token
    const futureExpiry = Math.floor(Date.now() / 1000) + 1800
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ token: 'new-token', expires_at: futureExpiry }),
    )

    const token = await manager.getToken()
    expect(token).toBe('new-token')
    expect(mockFetch).toHaveBeenCalledTimes(2)

    manager.dispose()
  })

  it('getTokenInfo returns null values when no token', () => {
    const manager = new TokenManager('github-access-token')
    const info = manager.getTokenInfo()

    expect(info.token).toBeNull()
    expect(info.expiresAt).toBeNull()
    expect(info.remainingSeconds).toBeNull()

    manager.dispose()
  })

  it('getTokenInfo returns truncated token and remaining seconds', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 600
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ token: 'abcdefghijklmnopqrstuvwxyz1234567890', expires_at: futureExpiry }),
    )

    const manager = new TokenManager('github-access-token')
    await manager.initialize()

    const info = manager.getTokenInfo()
    expect(info.token).toBe('abcdefghijklmnopqrst...')
    expect(info.expiresAt).toBe(futureExpiry)
    expect(info.remainingSeconds).toBeGreaterThan(0)
    expect(info.remainingSeconds).toBeLessThanOrEqual(600)

    manager.dispose()
  })

  it('dispose clears token and stops refresh timer', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 1800
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ token: 'token', expires_at: futureExpiry }),
    )

    const manager = new TokenManager('github-access-token')
    await manager.initialize()
    manager.dispose()

    const info = manager.getTokenInfo()
    expect(info.token).toBeNull()
  })

  it('updateAccessToken clears current token', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 1800
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ token: 'old', expires_at: futureExpiry }),
    )

    const manager = new TokenManager('old-github-token')
    await manager.initialize()

    manager.updateAccessToken('new-github-token')
    const info = manager.getTokenInfo()
    expect(info.token).toBeNull()

    manager.dispose()
  })

  it('throws on fetch failure', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse('Unauthorized', false, 401),
    )

    const manager = new TokenManager('bad-token')
    await expect(manager.initialize()).rejects.toThrow('Copilot token fetch failed')

    manager.dispose()
  })

  it('calls onTokenRefreshed callback on auto-refresh', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 1800
    const onRefreshed = vi.fn()

    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ token: 'initial', expires_at: futureExpiry }),
    )

    const manager = new TokenManager('github-token', { onTokenRefreshed: onRefreshed })
    await manager.initialize()

    // Setup response for auto-refresh
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ token: 'refreshed', expires_at: futureExpiry + 1800 }),
    )

    // Advance timer to trigger auto-refresh (25 minutes)
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000)

    expect(onRefreshed).toHaveBeenCalledTimes(1)
    expect(onRefreshed).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'refreshed' }),
    )

    manager.dispose()
  })

  it('calls onTokenError callback when auto-refresh fails', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 1800
    const onError = vi.fn()

    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ token: 'initial', expires_at: futureExpiry }),
    )

    const manager = new TokenManager('github-token', { onTokenError: onError })
    await manager.initialize()

    // Setup failure for auto-refresh
    mockFetch.mockResolvedValueOnce(
      createFetchResponse('Server Error', false, 500),
    )

    await vi.advanceTimersByTimeAsync(25 * 60 * 1000)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))

    manager.dispose()
  })
})
