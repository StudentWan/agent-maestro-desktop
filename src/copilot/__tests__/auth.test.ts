import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { requestDeviceCode, pollForAccessToken, getGitHubUsername, parseScopesHeader, computeMissingScopes, checkTokenScopes } from '../auth'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function createFetchResponse(data: unknown, ok = true, status = 200, headers?: Record<string, string>) {
  const headerMap = new Map<string, string>()
  if (headers) {
    for (const [k, v] of Object.entries(headers)) headerMap.set(k.toLowerCase(), v)
  }
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
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

  it('requests both read:user and codespace scopes', async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse({
      device_code: 'x', user_code: 'Y', verification_uri: 'z', expires_in: 1, interval: 1,
    }))

    await requestDeviceCode()

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
    // Primary device flow only asks for read:user; codespace is granted via
    // a separate flow because the Copilot OAuth App can't issue it.
    expect(body.scope).toBe('read:user')
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

    const error = await catchPromise as Error
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

    const error = await catchPromise as Error
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

    const error = await catchPromise as Error
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('OAuth error: some_other_error')
  })

  it('throws on HTTP error during polling', async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse({}, false, 500))

    const promise = pollForAccessToken('device-code', 100, 30)
    const catchPromise = promise.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(100)

    const error = await catchPromise as Error
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

describe('parseScopesHeader', () => {
  it('returns [] for null/undefined/empty', () => {
    expect(parseScopesHeader(null)).toEqual([])
    expect(parseScopesHeader(undefined)).toEqual([])
    expect(parseScopesHeader('')).toEqual([])
  })

  it('splits comma-separated scopes', () => {
    expect(parseScopesHeader('read:user, codespace')).toEqual(['read:user', 'codespace'])
  })

  it('trims whitespace and filters empty', () => {
    expect(parseScopesHeader('  read:user , , codespace  ')).toEqual(['read:user', 'codespace'])
  })
})

describe('computeMissingScopes', () => {
  it('returns [] when all required scopes present', () => {
    expect(computeMissingScopes(['read:user', 'codespace'])).toEqual([])
  })

  it('returns missing scopes in required order', () => {
    expect(computeMissingScopes(['read:user'])).toEqual(['codespace'])
    expect(computeMissingScopes([])).toEqual(['codespace'])
  })

  it('ignores extra scopes', () => {
    expect(computeMissingScopes(['read:user', 'codespace', 'repo', 'gist'])).toEqual([])
  })

  it('does not infer scope hierarchy (literal match only)', () => {
    // `repo` does NOT imply `codespace` even though gh's auth flow ties them
    expect(computeMissingScopes(['read:user', 'repo'])).toEqual(['codespace'])
  })

  it('accepts custom required list', () => {
    expect(computeMissingScopes(['gist'], ['gist', 'repo'])).toEqual(['repo'])
  })
})

describe('checkTokenScopes', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns hasAllRequiredScopes=true when token has both scopes', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ login: 'user' }, true, 200, { 'X-OAuth-Scopes': 'read:user, codespace' }),
    )
    const status = await checkTokenScopes('tok')
    expect(status.hasAllRequiredScopes).toBe(true)
    expect(status.missingScopes).toEqual([])
    expect(status.scopes).toContain('codespace')
  })

  it('reports missing codespace scope', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ login: 'user' }, true, 200, { 'X-OAuth-Scopes': 'read:user' }),
    )
    const status = await checkTokenScopes('tok')
    expect(status.hasAllRequiredScopes).toBe(false)
    expect(status.missingScopes).toEqual(['codespace'])
  })

  it('treats missing X-OAuth-Scopes header as no scopes', async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ login: 'user' }, true, 200, {}),
    )
    const status = await checkTokenScopes('tok')
    expect(status.scopes).toEqual([])
    expect(status.missingScopes).toEqual(['codespace'])
  })

  it('throws on 401', async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse({}, false, 401))
    await expect(checkTokenScopes('bad')).rejects.toThrow('Failed to check token scopes')
  })
})
