import { describe, it, expect, vi } from 'vitest'
import { buildCopilotAnthropicHeaders } from '../anthropic-headers'

// Mock uuid to produce deterministic values
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
}))

describe('buildCopilotAnthropicHeaders', () => {
  it('builds Copilot Anthropic headers with user initiator by default', () => {
    const headers = buildCopilotAnthropicHeaders('token', {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100,
    })

    expect(headers['Authorization']).toBe('Bearer token')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Accept']).toBe('application/json')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(headers['x-initiator']).toBe('user')
    expect(headers['Copilot-Integration-Id']).toBe('vscode-chat')
  })

  it('sets agent initiator for tool result follow-up turns and forwards supported beta headers', () => {
    const headers = buildCopilotAnthropicHeaders(
      'token',
      {
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'Done' }],
          },
        ],
        max_tokens: 100,
      },
      { anthropicBeta: 'context-1m-2025-08-07,prompt-caching-2024-07-31' },
    )

    expect(headers['x-initiator']).toBe('agent')
    expect(headers['anthropic-beta']).toBe('prompt-caching-2024-07-31')
  })

  it('omits context-1m beta header because Copilot uses model IDs for 1M context', () => {
    const headers = buildCopilotAnthropicHeaders(
      'token',
      {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      },
      { anthropicBeta: 'context-1m-2025-08-07' },
    )

    expect(headers['anthropic-beta']).toBeUndefined()
  })

  it('sets Copilot vision header when images are present', () => {
    const headers = buildCopilotAnthropicHeaders('token', {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          ],
        },
      ],
      max_tokens: 100,
    })

    expect(headers['Copilot-Vision-Request']).toBe('true')
  })
})
