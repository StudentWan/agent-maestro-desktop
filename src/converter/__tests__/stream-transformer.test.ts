import { describe, it, expect } from 'vitest'
import { createStreamTransformer } from '../stream-transformer'

function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

async function runTransformer(
  chunks: string[],
  model = 'claude-sonnet-4-6',
  inputTokens = 100,
): Promise<string> {
  const transformer = createStreamTransformer(model, inputTokens)
  const writer = transformer.writable.getWriter()
  const reader = transformer.readable.getReader()
  const output: string[] = []

  await Promise.all([
    (async () => {
      for (const chunk of chunks) {
        await writer.write(encode(chunk))
      }
      await writer.close()
    })(),
    (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        output.push(value)
      }
    })(),
  ])

  return output.join('')
}

describe('createStreamTransformer', () => {
  it('transforms a simple text stream', async () => {
    const chunks = [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const output = await runTransformer(chunks)

    expect(output).toContain('"type":"message_start"')
    expect(output).toContain('"type":"content_block_start"')
    expect(output).toContain('"text":"Hello"')
    expect(output).toContain('" world"')
    expect(output).toContain('"type":"content_block_stop"')
    expect(output).toContain('"type":"message_stop"')
    expect(output).toContain('"model":"claude-sonnet-4-6"')
  })

  it('handles malformed and empty chunks gracefully', async () => {
    const chunks = [
      '',
      'garbage',
      'data: [DONE]\n\n',
    ]

    const output = await runTransformer(chunks)
    expect(output).toContain('"type":"message_stop"')
    expect(output).toContain('"type":"message_start"')
  })

  it('handles tool_calls in stream', async () => {
    const chunks = [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const output = await runTransformer(chunks)
    expect(output).toContain('"type":"tool_use"')
    expect(output).toContain('"name":"get_weather"')
    expect(output).toContain('"stop_reason":"tool_use"')
  })

  it('handles finish_reason "stop"', async () => {
    const chunks = [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"Done"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const output = await runTransformer(chunks)
    expect(output).toContain('"stop_reason":"end_turn"')
  })

  it('handles finish_reason "length"', async () => {
    const chunks = [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"truncated"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const output = await runTransformer(chunks)
    expect(output).toContain('"stop_reason":"max_tokens"')
  })

  it('emits message_start on first chunk even without content', async () => {
    const chunks = [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const output = await runTransformer(chunks)
    expect(output).toContain('"type":"message_start"')
    expect(output).toContain('"type":"message_stop"')
  })

  it('uses the provided model name in output', async () => {
    const chunks = [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const output = await runTransformer(chunks, 'claude-opus-4-6', 50)
    expect(output).toContain('"model":"claude-opus-4-6"')
  })

  it('flushes remaining buffer on stream end', async () => {
    // Chunk without trailing double newline — will be in buffer at flush time
    const transformer = createStreamTransformer('claude-sonnet-4-6', 10)
    const writer = transformer.writable.getWriter()
    const reader = transformer.readable.getReader()
    const output: string[] = []

    await Promise.all([
      (async () => {
        // Write a chunk that doesn't end with \n\n
        await writer.write(encode('data: {"id":"c","choices":[{"index":0,"delta":{"content":"x"}}]}'))
        await writer.close()
      })(),
      (async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          output.push(value)
        }
      })(),
    ])

    const fullOutput = output.join('')
    expect(fullOutput).toContain('"type":"message_start"')
    expect(fullOutput).toContain('"type":"message_stop"')
  })

  it('handles empty choices array', async () => {
    const chunks = [
      'data: {"id":"cmpl-1","choices":[]}\n\n',
      'data: [DONE]\n\n',
    ]

    const output = await runTransformer(chunks)
    expect(output).toContain('"type":"message_start"')
    expect(output).toContain('"type":"message_stop"')
  })
})
