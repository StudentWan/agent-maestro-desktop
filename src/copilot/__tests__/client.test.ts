import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CopilotClient } from '../client'
import { TokenManager } from '../token-manager'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function createFetchResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    body: null,
  }
}

describe('CopilotClient', () => {
  let client: CopilotClient
  let tokenManager: TokenManager

  beforeEach(() => {
    mockFetch.mockReset()

    // Create a mock TokenManager
    tokenManager = {
      getToken: vi.fn().mockResolvedValue('jwt-copilot-token'),
    } as unknown as TokenManager

    client = new CopilotClient(tokenManager)
  })

  describe('chatCompletion', () => {
    it('sends non-streaming request and returns response', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4.1',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop',
        }],
      }

      mockFetch.mockResolvedValueOnce(createFetchResponse(mockResponse))

      const request = {
        model: 'gpt-4.1',
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: false,
      }

      const result = await client.chatCompletion(request)
      expect(result.choices[0].message?.content).toBe('Hello!')

      // Verify stream is forced to false
      const fetchCall = mockFetch.mock.calls[0]
      const body = JSON.parse(fetchCall[1].body)
      expect(body.stream).toBe(false)
    })

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        createFetchResponse('Rate limited', false, 429),
      )

      const request = {
        model: 'gpt-4.1',
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: false,
      }

      await expect(client.chatCompletion(request)).rejects.toThrow('Copilot API error')
    })
  })

  describe('chatCompletionStream', () => {
    it('sends streaming request and returns raw Response', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        body: 'mock-body-stream',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      }

      mockFetch.mockResolvedValueOnce(mockResponse)

      const request = {
        model: 'gpt-4.1',
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: true,
      }

      const result = await client.chatCompletionStream(request)
      expect(result.body).toBe('mock-body-stream')

      // Verify stream is forced to true
      const fetchCall = mockFetch.mock.calls[0]
      const body = JSON.parse(fetchCall[1].body)
      expect(body.stream).toBe(true)
    })

    it('throws on stream API error', async () => {
      mockFetch.mockResolvedValueOnce(
        createFetchResponse('Internal error', false, 500),
      )

      const request = {
        model: 'gpt-4.1',
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: true,
      }

      await expect(client.chatCompletionStream(request)).rejects.toThrow('Copilot API stream error')
    })
  })
})
