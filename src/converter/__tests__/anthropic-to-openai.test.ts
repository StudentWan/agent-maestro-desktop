import { describe, it, expect } from 'vitest'
import { convertAnthropicToOpenAI } from '../anthropic-to-openai'
import type { AnthropicRequest } from '../types'

describe('convertAnthropicToOpenAI', () => {
  it('converts a simple user message', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.model).toBe('claude-sonnet-4.6')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' })
    expect(result.max_tokens).toBe(1024)
    expect(result.stream).toBe(false)
  })

  it('converts a string system prompt', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100,
      system: 'You are helpful',
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful' })
    expect(result.messages[1]).toEqual({ role: 'user', content: 'Hi' })
  })

  it('converts an array system prompt', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100,
      system: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.messages[0].content).toBe('Part 1\n\nPart 2')
  })

  it('passes through optional parameters', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100,
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ['END'],
      stream: true,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.temperature).toBe(0.7)
    expect(result.top_p).toBe(0.9)
    expect(result.stop).toEqual(['END'])
    expect(result.stream).toBe(true)
  })

  it('does not include optional params when not provided', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.temperature).toBeUndefined()
    expect(result.top_p).toBeUndefined()
    expect(result.stop).toBeUndefined()
  })

  it('passes max_tokens through without clamping', () => {
    const request: AnthropicRequest = {
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 999999,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.max_tokens).toBe(999999)
  })

  it('converts assistant message with text content blocks', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
          ],
        },
      ],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.messages[0].role).toBe('assistant')
    expect(result.messages[0].content).toBe('Hello world')
  })

  it('converts assistant message with tool_use blocks', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'get_weather',
              input: { city: 'Paris' },
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.messages[0].role).toBe('assistant')
    expect(result.messages[0].content).toBe('Let me check')
    expect(result.messages[0].tool_calls).toHaveLength(1)
    expect(result.messages[0].tool_calls![0]).toEqual({
      id: 'tool_1',
      type: 'function',
      function: {
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
      },
    })
  })

  it('converts user message with tool_result blocks', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'Sunny, 25°C',
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.messages[0].role).toBe('tool')
    expect(result.messages[0].content).toBe('Sunny, 25°C')
    expect(result.messages[0].tool_call_id).toBe('tool_1')
  })

  it('converts tool_result with array content', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: [
                { type: 'text', text: 'Result line 1' },
                { type: 'text', text: 'Result line 2' },
              ],
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.messages[0].content).toBe('Result line 1\nResult line 2')
  })

  it('converts tool_result with empty content', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.messages[0].role).toBe('tool')
    expect(result.messages[0].content).toBe('')
  })

  it('handles user message with mixed text and tool_result blocks', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'Result',
            },
            { type: 'text', text: 'And my follow-up' },
          ],
        },
      ],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    // tool result comes first, then text
    expect(result.messages[0].role).toBe('tool')
    expect(result.messages[1].role).toBe('user')
    expect(result.messages[1].content).toBe('And my follow-up')
  })

  it('handles image blocks in user messages', () => {
    const request: AnthropicRequest = {
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
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.messages[0].content).toBe('[Image content omitted]')
  })

  it('filters out thinking blocks', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think...' },
            { type: 'text', text: 'Here is my answer' },
          ],
        },
      ],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.messages[0].content).toBe('Here is my answer')
  })

  it('filters out redacted_thinking blocks', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'redacted' },
            { type: 'text', text: 'Answer' },
          ],
        },
      ],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.messages[0].content).toBe('Answer')
  })

  it('handles empty user content blocks', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: [] },
      ],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    // Should produce an empty user message to avoid dropping the turn
    expect(result.messages[0].role).toBe('user')
    expect(result.messages[0].content).toBe('')
  })

  it('converts tools in the request', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100,
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      tool_choice: { type: 'auto' },
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.tools).toHaveLength(1)
    expect(result.tool_choice).toBe('auto')
  })

  it('does not include tools when empty', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100,
      tools: [],
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.tools).toBeUndefined()
    expect(result.tool_choice).toBeUndefined()
  })

  it('maps haiku model to Copilot format', () => {
    const request: AnthropicRequest = {
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.model).toBe('claude-haiku-4.5')
  })

  it('assistant message with only tool_use (no text) sets content to null', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'search',
              input: { query: 'test' },
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const result = convertAnthropicToOpenAI(request)
    expect(result.messages[0].content).toBeNull()
    expect(result.messages[0].tool_calls).toHaveLength(1)
  })
})
