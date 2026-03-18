import { createStreamTransformer } from "./converter/stream-transformer";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function testStreamTransformer() {
  console.log("=== Stream Transformer Tests ===\n");

  // Test 1: Simple text streaming
  console.log("--- Test 1: Simple text stream ---");
  {
    const transformer = createStreamTransformer("claude-sonnet-4-6", 100);
    const writer = transformer.writable.getWriter();
    const reader = transformer.readable.getReader();

    const chunks = [
      'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4.1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4.1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4.1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4.1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const encoder = new TextEncoder();
    const output: string[] = [];

    // Write chunks
    const writePromise = (async () => {
      for (const chunk of chunks) {
        await writer.write(encoder.encode(chunk));
      }
      await writer.close();
    })();

    // Read output
    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output.push(value);
      }
    })();

    await Promise.all([writePromise, readPromise]);

    const fullOutput = output.join("");

    assert("has message_start", fullOutput.includes('"type":"message_start"'));
    assert("has content_block_start", fullOutput.includes('"type":"content_block_start"'));
    assert("has text_delta with Hello", fullOutput.includes('"text":"Hello"'));
    assert("has text_delta with world", fullOutput.includes('" world"'));
    assert("has content_block_stop", fullOutput.includes('"type":"content_block_stop"'));
    assert("has message_delta", fullOutput.includes('"type":"message_delta"'));
    assert("has end_turn stop_reason", fullOutput.includes('"stop_reason":"end_turn"'));
    assert("has message_stop", fullOutput.includes('"type":"message_stop"'));
    assert("model preserved", fullOutput.includes('"model":"claude-sonnet-4-6"'));
    assert("has SSE event format", fullOutput.includes("event: message_start"));
    assert("has SSE data format", fullOutput.includes("data: {"));
  }

  // Test 2: Tool call streaming
  console.log("\n--- Test 2: Tool call stream ---");
  {
    const transformer = createStreamTransformer("claude-sonnet-4-6", 50);
    const writer = transformer.writable.getWriter();
    const reader = transformer.readable.getReader();

    const chunks = [
      'data: {"id":"cmpl-2","object":"chat.completion.chunk","created":1234,"model":"gpt-4.1","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"Read","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"cmpl-2","object":"chat.completion.chunk","created":1234,"model":"gpt-4.1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"file"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"cmpl-2","object":"chat.completion.chunk","created":1234,"model":"gpt-4.1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\\\":\\\"test.txt\\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"cmpl-2","object":"chat.completion.chunk","created":1234,"model":"gpt-4.1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const encoder = new TextEncoder();
    const output: string[] = [];

    const writePromise = (async () => {
      for (const chunk of chunks) {
        await writer.write(encoder.encode(chunk));
      }
      await writer.close();
    })();

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output.push(value);
      }
    })();

    await Promise.all([writePromise, readPromise]);

    const fullOutput = output.join("");

    assert("has tool_use content_block_start", fullOutput.includes('"type":"tool_use"'));
    assert("has tool name Read", fullOutput.includes('"name":"Read"'));
    assert("has tool call id", fullOutput.includes('"id":"call_abc"'));
    assert("has input_json_delta", fullOutput.includes('"type":"input_json_delta"'));
    assert("has tool_use stop_reason", fullOutput.includes('"stop_reason":"tool_use"'));
    assert("has message_stop", fullOutput.includes('"type":"message_stop"'));
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

testStreamTransformer().catch(console.error);
