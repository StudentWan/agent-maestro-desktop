import { describe, it, expect } from 'vitest'
import { convertToolsToOpenAI, convertToolChoiceToOpenAI } from '../tool-converter'

describe('convertToolsToOpenAI', () => {
  it('returns undefined for undefined or empty tools', () => {
    expect(convertToolsToOpenAI(undefined)).toBeUndefined()
    expect(convertToolsToOpenAI([])).toBeUndefined()
  })

  it('converts a standard tool definition', () => {
    const tools = [{
      name: 'get_weather',
      description: 'Get weather info',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    }]

    const result = convertToolsToOpenAI(tools)
    expect(result).toHaveLength(1)
    expect(result![0].type).toBe('function')
    expect(result![0].function.name).toBe('get_weather')
    expect(result![0].function.description).toBe('Get weather info')
    expect(result![0].function.parameters).toEqual(tools[0].input_schema)
  })

  it('uses empty description and default parameters when missing', () => {
    const tools = [{ name: 'my_tool' }]
    const result = convertToolsToOpenAI(tools)
    expect(result).toHaveLength(1)
    expect(result![0].function.description).toBe('')
    expect(result![0].function.parameters).toEqual({ type: 'object', properties: {} })
  })

  it('filters out built-in Anthropic tool types without input_schema', () => {
    const tools = [
      { name: 'computer', type: 'computer_20241022' },
      { name: 'text_editor', type: 'text_editor_20241022' },
      { name: 'custom_tool', description: 'A custom tool', input_schema: { type: 'object', properties: {} } },
    ]
    const result = convertToolsToOpenAI(tools)
    expect(result).toHaveLength(1)
    expect(result![0].function.name).toBe('custom_tool')
  })

  it('keeps tools with type "custom"', () => {
    const tools = [{ name: 'my_tool', type: 'custom' }]
    const result = convertToolsToOpenAI(tools)
    expect(result).toHaveLength(1)
  })

  it('converts multiple tools', () => {
    const tools = [
      { name: 'tool_a', description: 'A', input_schema: { type: 'object', properties: {} } },
      { name: 'tool_b', description: 'B', input_schema: { type: 'object', properties: {} } },
    ]
    const result = convertToolsToOpenAI(tools)
    expect(result).toHaveLength(2)
  })
})

describe('convertToolChoiceToOpenAI', () => {
  it('returns undefined for undefined input', () => {
    expect(convertToolChoiceToOpenAI(undefined)).toBeUndefined()
  })

  it('converts "auto" type', () => {
    expect(convertToolChoiceToOpenAI({ type: 'auto' })).toBe('auto')
  })

  it('converts "any" type to "required"', () => {
    expect(convertToolChoiceToOpenAI({ type: 'any' })).toBe('required')
  })

  it('converts "none" type', () => {
    expect(convertToolChoiceToOpenAI({ type: 'none' })).toBe('none')
  })

  it('converts "tool" type with name', () => {
    const result = convertToolChoiceToOpenAI({ type: 'tool', name: 'get_weather' })
    expect(result).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    })
  })

  it('converts "tool" type without name', () => {
    const result = convertToolChoiceToOpenAI({ type: 'tool' })
    expect(result).toEqual({
      type: 'function',
      function: { name: '' },
    })
  })

  it('defaults unknown type to "auto"', () => {
    expect(convertToolChoiceToOpenAI({ type: 'unknown' })).toBe('auto')
  })
})
