import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildCopilotAnthropicHeaders, buildCopilotHeaders, buildCopilotStreamHeaders } from '../headers'

// Mock uuid to produce deterministic values
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
}))

describe('buildCopilotHeaders', () => {
  it('includes Authorization bearer token', () => {
    const headers = buildCopilotHeaders('my-token')
    expect(headers['Authorization']).toBe('Bearer my-token')
  })

  it('sets Content-Type to application/json', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('sets Accept to application/json', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Accept']).toBe('application/json')
  })

  it('includes Editor-Version header', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Editor-Version']).toBeDefined()
    expect(headers['Editor-Version']).toContain('vscode/')
  })

  it('includes Editor-Plugin-Version header', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Editor-Plugin-Version']).toBeDefined()
    expect(headers['Editor-Plugin-Version']).toContain('copilot-chat/')
  })

  it('includes User-Agent header', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['User-Agent']).toBeDefined()
  })

  it('includes X-Request-Id from uuid', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['X-Request-Id']).toBe('test-uuid-1234')
  })

  it('includes Openai-Organization header', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Openai-Organization']).toBe('github-copilot')
  })

  it('includes Copilot-Integration-Id header', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Copilot-Integration-Id']).toBe('vscode-chat')
  })
})

describe('buildCopilotStreamHeaders', () => {
  it('overrides Accept to text/event-stream', () => {
    const headers = buildCopilotStreamHeaders('token')
    expect(headers['Accept']).toBe('text/event-stream')
  })

  it('still includes Authorization', () => {
    const headers = buildCopilotStreamHeaders('token')
    expect(headers['Authorization']).toBe('Bearer token')
  })

  it('still includes all other headers from base', () => {
    const headers = buildCopilotStreamHeaders('token')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Openai-Organization']).toBe('github-copilot')
  })
})

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
