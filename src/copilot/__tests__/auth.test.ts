import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { requestDeviceCode, pollForAccessToken, getGitHubUsername } from '../auth'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function createFetchResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

describe('requestDeviceCode', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns device code response on success', async () => {
    const deviceCodeData = {
      device_code: 'abc123',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    }
    mockFetch.mockResolvedValueOnce(createFetchResponse(deviceCodeData))

    const result = await requestDeviceCode()
    expect(result.device_code).toBe('abc123')
    expect(result.user_code).toBe('ABCD-1234')
    expect(result.verification_uri).toBe('https://github.com/login/device')
  })

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse({}, false, 500))
    await expect(requestDeviceCode()).rejects.toThrow('Device code request failed')
  })

  it('sends correct headers and body', async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse({
      device_code: 'x', user_code: 'Y', verification_uri: 'z', expires_in: 1, interval: 1,
    }))

    await requestDeviceCode()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('github.com'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        }),
      }),
    )
  })
})

describe('pollForAccessToken', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns access token when authorization completes', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ error: 'authorization_pending' }),
    )
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ access_token: 'gho_token123' }),
    )

    const promise = pollForAccessToken('device-code', 100, 30)

    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(100)

    const result = await promise
    expect(result).toBe('gho_token123')
  })

  it('throws on expired_token error', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ error: 'expired_token' }),
    )

    const promise = pollForAccessToken('device-code', 100, 30)
    // Attach rejection handler immediately to prevent unhandled rejection
    const catchPromise = promise.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(100)

    const error = await catchPromise
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('Device code expired')
  })

  it('throws on access_denied error', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ error: 'access_denied' }),
    )

    const promise = pollForAccessToken('device-code', 100, 30)
    const catchPromise = promise.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(100)

    const error = await catchPromise
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('Authorization was denied')
  })

  it('throws on unknown OAuth error', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ error: 'some_other_error' }),
    )

    const promise = pollForAccessToken('device-code', 100, 30)
    const catchPromise = promise.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(100)

    const error = await catchPromise
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('OAuth error: some_other_error')
  })

  it('throws on HTTP error during polling', async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse({}, false, 500))

    const promise = pollForAccessToken('device-code', 100, 30)
    const catchPromise = promise.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(100)

    const error = await catchPromise
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('Token polling failed')
  })

  it('increases interval on slow_down', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ error: 'slow_down' }),
    )
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ access_token: 'token' }),
    )

    const promise = pollForAccessToken('device-code', 100, 30)
    // First poll after 100ms gets slow_down
    await vi.advanceTimersByTimeAsync(100)
    // Next poll after 100 + 5000 = 5100ms
    await vi.advanceTimersByTimeAsync(5100)
    const result = await promise

    expect(result).toBe('token')
  })
})

describe('getGitHubUsername', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns username on success', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ login: 'testuser' }),
    )

    const username = await getGitHubUsername('my-access-token')
    expect(username).toBe('testuser')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'token my-access-token',
        }),
      }),
    )
  })

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse({}, false, 401))
    await expect(getGitHubUsername('bad-token')).rejects.toThrow('Failed to fetch GitHub user')
  })
})
