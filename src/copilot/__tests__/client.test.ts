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
      getTokenBundle: vi.fn().mockResolvedValue({
        token: 'jwt-copilot-token',
        expiresAt: Math.floor(Date.now() / 1000) + 1800,
        baseUrl: 'https://api.individual.githubcopilot.com',
      }),
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

  describe('anthropicMessages', () => {
    it('sends non-streaming Anthropic Messages request with prompt cache markers', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }

      mockFetch.mockResolvedValueOnce(createFetchResponse(mockResponse))

      const result = await client.anthropicMessages(
        {
          model: 'claude-sonnet-4-6',
          system: 'Follow policy.',
          tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 100,
        },
        { anthropicBeta: 'prompt-caching-2024-07-31' },
      )

      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello!' })
      const fetchCall = mockFetch.mock.calls[0]
      expect(fetchCall[0]).toBe('https://api.individual.githubcopilot.com/v1/messages')
      expect(fetchCall[1].headers).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer jwt-copilot-token',
          'anthropic-beta': 'prompt-caching-2024-07-31',
          'x-initiator': 'user',
        }),
      )
      const body = JSON.parse(fetchCall[1].body)
      expect(body.model).toBe('claude-sonnet-4.6')
      expect(body.stream).toBe(false)
      expect(body.system).toEqual([
        { type: 'text', text: 'Follow policy.', cache_control: { type: 'ephemeral' } },
      ])
      expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral' })
      expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' })
    })

    it('resolves context-1m Claude beta requests to Copilot 1M model IDs', async () => {
      mockFetch.mockResolvedValueOnce(createFetchResponse({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4.6-1m',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }))

      const result = await client.anthropicMessages(
        {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 100,
        },
        { anthropicBeta: 'context-1m-2025-08-07' },
      )

      const fetchCall = mockFetch.mock.calls[0]
      expect(fetchCall[1].headers['anthropic-beta']).toBeUndefined()
      const body = JSON.parse(fetchCall[1].body)
      expect(body.model).toBe('claude-sonnet-4.6-1m')
      expect(result.model).toBe('claude-sonnet-4-6')
    })

    it('adapts unsupported thinking and web search fields for Copilot Anthropic endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createFetchResponse({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4.6',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }))

      await client.anthropicMessages({
        model: 'claude-sonnet-4-6',
        thinking: { type: 'enabled', budget_tokens: 16000 },
        tools: [
          { name: 'web_search', type: 'web_search_20250305', max_uses: 5 },
          { name: 'read_file', input_schema: { type: 'object' } },
        ],
        tool_choice: { type: 'tool', name: 'web_search' },
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      })

      const fetchCall = mockFetch.mock.calls[0]
      const body = JSON.parse(fetchCall[1].body)
      expect(body.thinking).toEqual({ type: 'adaptive' })
      expect(body.output_config).toEqual({ effort: 'high' })
      expect(body.tools).toHaveLength(1)
      expect(body.tools[0].name).toBe('read_file')
      expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral' })
      expect(body.tool_choice).toBeUndefined()
    })

    it('removes tool_choice when every tool is unsupported by Copilot', async () => {
      mockFetch.mockResolvedValueOnce(createFetchResponse({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4.6',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }))

      await client.anthropicMessages({
        model: 'claude-sonnet-4-6',
        tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: 5 }],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      })

      const fetchCall = mockFetch.mock.calls[0]
      const body = JSON.parse(fetchCall[1].body)
      expect(body.tools).toBeUndefined()
      expect(body.tool_choice).toBeUndefined()
    })

    it.each([
      ['claude-haiku-4-5-20251001', 'claude-haiku-4.5'],
      ['claude-sonnet-4.5', 'claude-sonnet-4.5'],
      ['claude-opus-4.5', 'claude-opus-4.5'],
    ])('strips reasoning effort for %s because Copilot does not support it', async (requestedModel, copilotModel) => {
      mockFetch.mockResolvedValueOnce(createFetchResponse({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: copilotModel,
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }))

      await client.anthropicMessages({
        model: requestedModel,
        thinking: { type: 'enabled', budget_tokens: 16000 },
        output_config: { effort: 'high' },
        context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      })

      const fetchCall = mockFetch.mock.calls[0]
      const body = JSON.parse(fetchCall[1].body)
      expect(body.model).toBe(copilotModel)
      expect(body.thinking).toBeUndefined()
      expect(body.output_config).toBeUndefined()
      expect(body.context_management).toBeUndefined()
    })

    it.each([
      ['claude-opus-4.7', 'medium'],
      ['claude-opus-4.7-high', 'high'],
      ['claude-opus-4.7-xhigh', 'xhigh'],
    ])('normalizes reasoning effort for %s', async (requestedModel, expectedEffort) => {
      mockFetch.mockResolvedValueOnce(createFetchResponse({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: requestedModel,
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }))

      await client.anthropicMessages({
        model: requestedModel,
        thinking: { type: 'enabled', budget_tokens: 16000 },
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      })

      const fetchCall = mockFetch.mock.calls[0]
      const body = JSON.parse(fetchCall[1].body)
      expect(body.output_config).toEqual({ effort: expectedEffort })
    })

    it('sends streaming Anthropic Messages request and returns raw Response', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        body: 'mock-anthropic-stream',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      }

      mockFetch.mockResolvedValueOnce(mockResponse)

      const result = await client.anthropicMessagesStream({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
        stream: true,
      })

      expect(result.body).toBe('mock-anthropic-stream')
      const fetchCall = mockFetch.mock.calls[0]
      const body = JSON.parse(fetchCall[1].body)
      expect(body.stream).toBe(true)
    })

    it('throws on Anthropic Messages API error', async () => {
      mockFetch.mockResolvedValueOnce(
        createFetchResponse('Bad request', false, 400),
      )

      await expect(client.anthropicMessages({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      })).rejects.toThrow('Copilot Anthropic Messages error')
    })
  })
})
