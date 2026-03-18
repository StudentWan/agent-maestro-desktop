import { describe, it, expect } from 'vitest'
import { convertOpenAIToAnthropic } from '../openai-to-anthropic'
import type { CopilotCompletionResponse } from '../../copilot/types'

function makeResponse(overrides: Partial<CopilotCompletionResponse> = {}): CopilotCompletionResponse {
  return {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4.1',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'Hello!' },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    ...overrides,
  }
}

describe('convertOpenAIToAnthropic', () => {
  it('converts a simple text response', () => {
    const response = makeResponse()
    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')

    expect(result.type).toBe('message')
    expect(result.role).toBe('assistant')
    expect(result.model).toBe('claude-sonnet-4-6')
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Hello!',
      citations: null,
    })
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  it('uses the original model name, not the copilot model', () => {
    const response = makeResponse()
    const result = convertOpenAIToAnthropic(response, 'claude-opus-4-6')
    expect(result.model).toBe('claude-opus-4-6')
  })

  it('handles tool_calls in choice', () => {
    const response = makeResponse({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Let me search',
          tool_calls: [{
            id: 'call_abc',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"city":"Paris"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })

    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Let me search',
      citations: null,
    })
    expect(result.content[1]).toEqual({
      type: 'tool_use',
      id: 'call_abc',
      name: 'get_weather',
      input: { city: 'Paris' },
    })
    expect(result.stop_reason).toBe('tool_use')
  })

  it('handles malformed tool arguments as raw', () => {
    const response = makeResponse({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'my_tool',
              arguments: 'not json',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })

    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')
    const toolBlock = result.content.find((b) => b.type === 'tool_use')
    expect(toolBlock).toBeDefined()
    if (toolBlock?.type === 'tool_use') {
      expect(toolBlock.input).toEqual({ raw: 'not json' })
    }
  })

  it('returns empty response when no choices', () => {
    const response = makeResponse({ choices: [] })
    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')
    expect(result.content).toEqual([])
    expect(result.stop_reason).toBe('end_turn')
  })

  it('returns empty response when choice has no message', () => {
    const response = makeResponse({
      choices: [{ index: 0, finish_reason: 'stop' } as any],
    })
    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')
    expect(result.content).toEqual([])
  })

  it('maps finish_reason "length" to "max_tokens"', () => {
    const response = makeResponse({
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'truncated' },
        finish_reason: 'length',
      }],
    })

    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')
    expect(result.stop_reason).toBe('max_tokens')
  })

  it('maps finish_reason "content_filter" to "end_turn"', () => {
    const response = makeResponse({
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'filtered' },
        finish_reason: 'content_filter',
      }],
    })

    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')
    expect(result.stop_reason).toBe('end_turn')
  })

  it('maps null finish_reason to "end_turn"', () => {
    const response = makeResponse({
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hi' },
        finish_reason: null,
      }],
    })

    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')
    expect(result.stop_reason).toBe('end_turn')
  })

  it('defaults usage to 0 when not provided', () => {
    const response = makeResponse({ usage: undefined })
    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')
    expect(result.usage.input_tokens).toBe(0)
    expect(result.usage.output_tokens).toBe(0)
  })

  it('generates an id starting with msg_', () => {
    const response = makeResponse()
    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')
    expect(result.id).toMatch(/^msg_/)
  })

  it('does not include text block when content is null', () => {
    const response = makeResponse({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'tool', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })

    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')
    const textBlocks = result.content.filter((b) => b.type === 'text')
    expect(textBlocks).toHaveLength(0)
  })

  it('sets stop_reason to tool_use when tool_calls present even with stop finish_reason', () => {
    const response = makeResponse({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'text',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'tool', arguments: '{}' },
          }],
        },
        finish_reason: 'stop',
      }],
    })

    const result = convertOpenAIToAnthropic(response, 'claude-sonnet-4-6')
    expect(result.stop_reason).toBe('tool_use')
  })
})
