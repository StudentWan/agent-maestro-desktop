import { convertAnthropicToOpenAI } from "./converter/anthropic-to-openai";
import { convertOpenAIToAnthropic } from "./converter/openai-to-anthropic";
import { mapModelName } from "./converter/model-mapper";

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

console.log("=== Model Mapping ===");
assert("sonnet → gpt-4.1", mapModelName("claude-sonnet-4-6") === "gpt-4.1");
assert("opus → gpt-4.1", mapModelName("claude-opus-4-6") === "gpt-4.1");
assert("haiku → gpt-4o-mini", mapModelName("claude-haiku-4-5-20251001") === "gpt-4o-mini");
assert("old haiku → gpt-4o-mini", mapModelName("claude-3-5-haiku-20241022") === "gpt-4o-mini");

console.log("\n=== Simple Request Conversion ===");
const simple = convertAnthropicToOpenAI({
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Hello world" }],
  max_tokens: 100,
  system: "You are helpful",
});
assert("model mapped", simple.model === "gpt-4.1");
assert("system message added", simple.messages[0].role === "system");
assert("system content correct", simple.messages[0].content === "You are helpful");
assert("user message preserved", simple.messages[1].role === "user");
assert("user content correct", simple.messages[1].content === "Hello world");
assert("max_tokens set", simple.max_tokens === 100);

console.log("\n=== Multi-turn Conversion ===");
const multi = convertAnthropicToOpenAI({
  model: "claude-opus-4-6",
  messages: [
    { role: "user", content: "What is 2+2?" },
    { role: "assistant", content: "4" },
    { role: "user", content: "And 3+3?" },
  ],
  max_tokens: 200,
  system: [{ type: "text", text: "Math tutor." }],
  temperature: 0.5,
});
assert("4 messages (1 system + 3 turns)", multi.messages.length === 4);
assert("temperature preserved", multi.temperature === 0.5);

console.log("\n=== Tool Use Request ===");
const toolReq = convertAnthropicToOpenAI({
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Read package.json" }],
  max_tokens: 1000,
  tools: [{
    name: "Read",
    description: "Read a file",
    input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  }],
  tool_choice: { type: "auto" },
});
assert("has tools", !!toolReq.tools && toolReq.tools.length === 1);
assert("tool name", toolReq.tools![0].function.name === "Read");
assert("tool_choice auto", toolReq.tool_choice === "auto");

console.log("\n=== Tool Call in Assistant Message ===");
const toolCallReq = convertAnthropicToOpenAI({
  model: "claude-sonnet-4-6",
  messages: [
    { role: "user", content: "Read it" },
    { role: "assistant", content: [
      { type: "text", text: "Let me read." },
      { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.txt" } },
    ]},
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_1", content: "file contents here" },
    ]},
  ],
  max_tokens: 500,
});
const assistantMsg = toolCallReq.messages.find(m => m.role === "assistant");
assert("assistant has tool_calls", !!assistantMsg?.tool_calls && assistantMsg.tool_calls.length === 1);
assert("tool call id", assistantMsg?.tool_calls?.[0].id === "call_1");
assert("tool call name", assistantMsg?.tool_calls?.[0].function.name === "Read");
const toolMsg = toolCallReq.messages.find(m => m.role === "tool");
assert("tool result message exists", !!toolMsg);
assert("tool result content", toolMsg?.content === "file contents here");
assert("tool_call_id set", toolMsg?.tool_call_id === "call_1");

console.log("\n=== Thinking Block Filter ===");
const thinkingReq = convertAnthropicToOpenAI({
  model: "claude-sonnet-4-6",
  messages: [
    { role: "assistant", content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "The answer is 42." },
    ]},
    { role: "user", content: "OK" },
  ],
  max_tokens: 100,
});
const assistantContent = thinkingReq.messages.find(m => m.role === "assistant")?.content;
assert("thinking filtered out", typeof assistantContent === "string" && !assistantContent.includes("think"));
assert("text preserved", typeof assistantContent === "string" && assistantContent.includes("42"));

console.log("\n=== Response Conversion (text) ===");
const textResp = convertOpenAIToAnthropic({
  id: "cmpl-1",
  object: "chat.completion",
  created: Date.now(),
  model: "gpt-4.1",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
} as any, "claude-sonnet-4-6");
assert("response type message", textResp.type === "message");
assert("response model preserved", textResp.model === "claude-sonnet-4-6");
assert("stop_reason end_turn", textResp.stop_reason === "end_turn");
assert("content has text block", textResp.content[0].type === "text");
assert("text content correct", (textResp.content[0] as any).text === "Hello!");
assert("input_tokens", textResp.usage.input_tokens === 10);
assert("output_tokens", textResp.usage.output_tokens === 5);

console.log("\n=== Response Conversion (tool_use) ===");
const toolUseResp = convertOpenAIToAnthropic({
  id: "cmpl-2",
  object: "chat.completion",
  created: Date.now(),
  model: "gpt-4.1",
  choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{
    id: "call_a",
    type: "function",
    function: { name: "Read", arguments: '{"file_path":"test.txt"}' },
  }] }, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
} as any, "claude-sonnet-4-6");
assert("stop_reason tool_use", toolUseResp.stop_reason === "tool_use");
assert("has tool_use block", toolUseResp.content.some(b => b.type === "tool_use"));
const toolBlock = toolUseResp.content.find(b => b.type === "tool_use") as any;
assert("tool id", toolBlock.id === "call_a");
assert("tool name", toolBlock.name === "Read");
assert("tool input parsed", toolBlock.input.file_path === "test.txt");

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
