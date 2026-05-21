import { describe, expect, it } from 'vitest'
import { applyCopilotPromptCache, countCacheControlMarkers } from '../prompt-cache'
import type { AnthropicRequest } from '../converter/types'

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

  // Regression: Claude Code now attaches cache_control markers itself, with
  // forward-looking sub-fields like `scope` / `ttl`. Anthropic accepts them;
  // Copilot's Anthropic Messages endpoint rejects with HTTP 400
  // (`cache_control.ephemeral.scope: Extra inputs are not permitted`).
  // We must reduce every marker to {type} BEFORE the request leaves us.
  it('strips unknown cache_control sub-fields like scope/ttl from every marker', () => {
    const request = {
      model: 'claude-sonnet-4-6',
      system: [
        {
          type: 'text',
          text: 'system text',
          cache_control: { type: 'ephemeral', scope: 'session' },
        },
      ],
      tools: [
        {
          name: 'read_file',
          input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'hello',
              cache_control: { type: 'ephemeral', scope: 'turn', ttl: '1h' },
            },
          ],
        },
      ],
      max_tokens: 100,
    } as unknown as AnthropicRequest

    const result = applyCopilotPromptCache(request)

    const systemBlock = (result.system as Array<{ cache_control?: unknown }>)[0]
    expect(systemBlock.cache_control).toEqual({ type: 'ephemeral' })
    expect(result.tools?.[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(
      (result.messages[0].content as Array<{ cache_control?: unknown }>)[0]
        .cache_control,
    ).toEqual({ type: 'ephemeral' })

    // No marker should retain `scope` / `ttl` anywhere in the request.
    const wireBytes = JSON.stringify(result)
    expect(wireBytes).not.toMatch(/"scope"\s*:/)
    expect(wireBytes).not.toMatch(/"ttl"\s*:/)
  })

  it('drops cache_control entirely when its shape is unrecognisable', () => {
    const request = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            // Missing `type` → not a cache marker we can normalise; drop it.
            { type: 'text', text: 'hello', cache_control: { ttl: '5m' } },
          ],
        },
      ],
      max_tokens: 100,
    } as unknown as AnthropicRequest

    const result = applyCopilotPromptCache(request)
    const block = (result.messages[0].content as unknown as Array<Record<string, unknown>>)[0]
    // The marker we removed for being malformed will NOT be re-added by the
    // budget walker (the trailing-user-block step *does* add a fresh
    // ephemeral marker, but on the same block — verify the wire is clean).
    expect(block.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('preserves a previously-set, already-canonical cache_control unchanged', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    }
    const result = applyCopilotPromptCache(request)
    const systemBlock = (result.system as Array<{ cache_control?: unknown }>)[0]
    expect(systemBlock.cache_control).toEqual({ type: 'ephemeral' })
  })
})
