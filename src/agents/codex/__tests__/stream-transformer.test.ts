import { describe, expect, it } from "vitest";
import { createResponsesStreamTransformer } from "../converter/stream-transformer";
import type { ResponsesStreamEvent } from "../converter/types";

/**
 * Build a Copilot-style SSE byte stream out of a list of `data: <json>`
 * payloads, terminated with `data: [DONE]`. Mirrors what the Copilot
 * `chat/completions` stream looks like on the wire.
 */
function buildCopilotSSE(payloads: unknown[]): Uint8Array {
  const lines = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`);
  lines.push("data: [DONE]\n\n");
  return new TextEncoder().encode(lines.join(""));
}

/**
 * Push a single byte chunk through the transformer and collect every
 * Responses event it emits, parsed back into objects.
 */
async function runTransformer(
  bytes: Uint8Array,
): Promise<ResponsesStreamEvent[]> {
  const transformer = createResponsesStreamTransformer("gpt-5");
  const writer = transformer.writable.getWriter();
  void writer.write(bytes).then(() => writer.close());

  const events: ResponsesStreamEvent[] = [];
  const reader = transformer.readable.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Each chunk may contain multiple event/data frames.
    for (const frame of value.split("\n\n")) {
      const trimmed = frame.trim();
      if (!trimmed) continue;
      const dataLine = trimmed
        .split("\n")
        .find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      events.push(JSON.parse(dataLine.slice(6)) as ResponsesStreamEvent);
    }
  }
  return events;
}

describe("createResponsesStreamTransformer", () => {
  it("emits the full text-only event sequence with monotonic sequence_number", async () => {
    const sse = buildCopilotSSE([
      { choices: [{ index: 0, delta: { content: "hel" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);

    const events = await runTransformer(sse);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);

    // Monotonic sequence_number across the entire stream.
    const seqs = events.map((e) => e.sequence_number);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    // Final content_part.done should carry the accumulated text.
    const partDone = events.find(
      (e): e is Extract<ResponsesStreamEvent, { type: "response.content_part.done" }> =>
        e.type === "response.content_part.done",
    );
    expect(partDone?.part.text).toBe("hello");

    // Snapshot inside `response.completed` should reflect the final text.
    const completed = events.find(
      (e): e is Extract<ResponsesStreamEvent, { type: "response.completed" }> =>
        e.type === "response.completed",
    );
    expect(completed?.response.status).toBe("completed");
    const item = completed?.response.output[0];
    if (item && item.type === "message") {
      expect(item.content[0]?.text).toBe("hello");
    } else {
      throw new Error("expected message output item");
    }
  });

  it("emits function_call_arguments events for tool calls and closes the item", async () => {
    const sse = buildCopilotSSE([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_xyz",
                  type: "function",
                  function: { name: "search", arguments: '{"q":"' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'rust"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);

    const events = await runTransformer(sse);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);

    const argsDone = events.find(
      (e): e is Extract<
        ResponsesStreamEvent,
        { type: "response.function_call_arguments.done" }
      > => e.type === "response.function_call_arguments.done",
    );
    expect(argsDone?.arguments).toBe('{"q":"rust"}');

    const itemDone = events.find(
      (e): e is Extract<ResponsesStreamEvent, { type: "response.output_item.done" }> =>
        e.type === "response.output_item.done",
    );
    if (itemDone?.item.type === "function_call") {
      expect(itemDone.item.call_id).toBe("call_xyz");
      expect(itemDone.item.name).toBe("search");
      expect(itemDone.item.arguments).toBe('{"q":"rust"}');
    } else {
      throw new Error("expected function_call output item");
    }
  });

  it("emits a placeholder text item even when the upstream sends only [DONE]", async () => {
    const sse = new TextEncoder().encode("data: [DONE]\n\n");
    const events = await runTransformer(sse);
    const types = events.map((e) => e.type);
    expect(types).toContain("response.created");
    expect(types).toContain("response.completed");
    // Placeholder text item ensures the response isn't completely empty.
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
  });

  it("forwards usage info from the final chunk into the completed snapshot", async () => {
    const sse = buildCopilotSSE([
      { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
      },
    ]);
    const events = await runTransformer(sse);
    const completed = events.find(
      (e): e is Extract<ResponsesStreamEvent, { type: "response.completed" }> =>
        e.type === "response.completed",
    );
    expect(completed?.response.usage).toEqual({
      input_tokens: 12,
      output_tokens: 1,
      total_tokens: 13,
    });
  });
});
