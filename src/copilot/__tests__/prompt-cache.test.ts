import { describe, expect, it } from 'vitest'
import { applyCopilotPromptCache, countCacheControlMarkers } from '../prompt-cache'
import type { AnthropicRequest } from '../../converter/types'

describe('applyCopilotPromptCache', () => {
  it('adds bounded cache markers to tools, system, and trailing user content', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: 'Stable part 1' },
        { type: 'text', text: 'Stable part 2' },
      ],
      tools: [
        { name: 'read_file', input_schema: { type: 'object' } },
        { name: 'write_file', input_schema: { type: 'object' } },
      ],
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100,
    }

    const result = applyCopilotPromptCache(request)

    expect(result).not.toBe(request)
    expect(result.tools?.[0]).not.toHaveProperty('cache_control')
    expect(result.tools?.[1]).toHaveProperty('cache_control', { type: 'ephemeral' })
    expect(Array.isArray(result.system)).toBe(true)
    expect(result.system).toEqual([
      { type: 'text', text: 'Stable part 1' },
      { type: 'text', text: 'Stable part 2', cache_control: { type: 'ephemeral' } },
    ])
    expect(result.messages[0].content).toEqual([
      { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
    ])
    expect(countCacheControlMarkers(result)).toBe(3)
    expect(countCacheControlMarkers(request)).toBe(0)
  })

  it('marks the last cacheable trailing user block without double-wrapping arrays', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First' },
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'Done' },
          ],
        },
      ],
      max_tokens: 100,
    }

    const result = applyCopilotPromptCache(request)

    expect(result.messages[0].content).toEqual([
      { type: 'text', text: 'First' },
      {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: 'Done',
        cache_control: { type: 'ephemeral' },
      },
    ])
  })

  it('does not add more than four cache markers', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: 'Already cached 1', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Already cached 2', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Dynamic' },
      ],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Cached turn', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'Latest turn' },
          ],
        },
      ],
      max_tokens: 100,
    }

    const result = applyCopilotPromptCache(request)

    expect(countCacheControlMarkers(result)).toBe(4)
    expect(result.tools?.[0]).toHaveProperty('cache_control', { type: 'ephemeral' })
    expect(Array.isArray(result.system)).toBe(true)
    expect((result.system as Array<{ cache_control?: unknown }>)[2]).not.toHaveProperty('cache_control')
    expect((result.messages[0].content as Array<{ cache_control?: unknown }>)[1]).not.toHaveProperty('cache_control')
  })
})
