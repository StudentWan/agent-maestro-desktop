import { describe, expect, it } from "vitest";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { createResponsesItemIdNormalizer } from "../responses-stream";

function sse(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function normalize(input: string, chunkSize = 17): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(createResponsesItemIdNormalizer())
    .getReader();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return result;
    result += value;
  }
}

function parseEvents(text: string): EventSourceMessage[] {
  const events: EventSourceMessage[] = [];
  createParser({ onEvent: (event) => events.push(event) }).feed(text);
  return events;
}

describe("Responses stream item IDs", () => {
  it("normalizes interleaved reasoning, text parts, and parallel tool calls without changing their payloads", async () => {
    const reasoning = { type: "reasoning", id: "reasoning_first", summary: [] };
    const message = {
      type: "message",
      id: "message_first",
      phase: "commentary",
      content: [],
    };
    const toolA = {
      type: "function_call",
      id: "tool_a_first",
      call_id: "call_a",
      name: "first",
      arguments: "",
    };
    const toolB = {
      type: "function_call",
      id: "tool_b_first",
      call_id: "call_b",
      name: "second",
      arguments: "",
    };
    const input = [
      { type: "response.output_item.added", output_index: 0, item: reasoning },
      { type: "response.output_item.added", output_index: 1, item: message },
      { type: "response.output_item.added", output_index: 2, item: toolA },
      { type: "response.output_item.added", output_index: 3, item: toolB },
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
        item_id: "reasoning_part",
        part: { type: "summary_text", text: "" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        item_id: "reasoning_delta",
        delta: "Checking once",
      },
      {
        type: "response.content_part.added",
        output_index: 1,
        content_index: 0,
        item_id: "message_part",
        part: { type: "output_text", text: "" },
      },
      {
        type: "response.output_text.delta",
        output_index: 1,
        content_index: 0,
        item_id: "message_delta",
        delta: "检查🙂",
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 3,
        item_id: "tool_b_delta",
        delta: '{"id":"do-not-change"}',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: "tool_a_delta",
        delta: "{}",
      },
      {
        type: "response.reasoning_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: "reasoning_raw",
        delta: "Reasoning text",
      },
      {
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        summary_index: 0,
        item_id: "reasoning_text_done",
        text: "Checking once",
      },
      {
        type: "response.reasoning_summary_part.done",
        output_index: 0,
        summary_index: 0,
        item_id: "reasoning_part_done",
        part: { type: "summary_text", text: "Checking once" },
      },
      {
        type: "response.output_text.done",
        output_index: 1,
        content_index: 0,
        item_id: "message_text_done",
        text: "检查🙂",
      },
      {
        type: "response.content_part.done",
        output_index: 1,
        content_index: 0,
        item_id: "message_part_done",
        part: { type: "output_text", text: "检查🙂" },
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 2,
        item_id: "tool_a_args_done",
        arguments: "{}",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          ...reasoning,
          id: "reasoning_done",
          encrypted_content: "opaque-final-reasoning",
          summary: [{ type: "summary_text", text: "Checking once" }],
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          ...message,
          id: "message_done",
          content: [{ type: "output_text", text: "检查🙂" }],
          internal_chat_message_metadata_passthrough: "opaque-metadata",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: { ...toolA, id: "tool_a_done", arguments: "{}" },
      },
      {
        type: "response.output_item.done",
        output_index: 3,
        item: {
          ...toolB,
          id: "tool_b_done",
          arguments: '{"id":"do-not-change"}',
        },
      },
    ].map((event, sequence_number) => ({ ...event, sequence_number }));

    const actual = parseEvents(await normalize(input.map(sse).join(""), 1)).map(
      (event) => JSON.parse(event.data),
    );
    expect(actual).toHaveLength(input.length);
    expect(actual.slice(0, 4)).toEqual(input.slice(0, 4));
    expect(actual.slice(4, 16).map((event) => event.item_id)).toEqual([
      "reasoning_first",
      "reasoning_first",
      "message_first",
      "message_first",
      "tool_b_first",
      "tool_a_first",
      "reasoning_first",
      "reasoning_first",
      "reasoning_first",
      "message_first",
      "message_first",
      "tool_a_first",
    ]);
    expect(actual.slice(16).map((event) => event.item.id)).toEqual([
      "reasoning_first",
      "message_first",
      "tool_a_first",
      "tool_b_first",
    ]);
    // Compare every other field to catch accidental changes to opaque data,
    // call_id, phase, sequence numbers, text, arguments, or tool ordering.
    actual.forEach((event, index) => {
      const original = input[index];
      if (original.item_id !== undefined) event.item_id = original.item_id;
      if (original.item !== undefined) event.item.id = original.item.id;
      expect(event).toEqual(original);
    });
  });

  it.each(["response.completed", "response.incomplete", "response.failed"])(
    "normalizes %s output snapshots while preserving response metadata",
    async (type) => {
      const final = {
        type,
        response: {
          id: "resp_unchanged",
          status: type.slice("response.".length),
          output: [
            {
              id: "reasoning_final",
              type: "reasoning",
              encrypted_content: "final-ciphertext",
            },
            {
              id: "message_final",
              type: "message",
              phase: "final_answer",
              content: [{ type: "output_text", text: "Done" }],
            },
          ],
          usage: { input_tokens: 8, output_tokens: 3 },
          error: { code: "example", message: "Example error" },
        },
      };
      const result = parseEvents(
        await normalize(
          [
            sse({
              type: "response.output_item.added",
              output_index: 0,
              item: { id: "reasoning_first", type: "reasoning" },
            }),
            sse({
              type: "response.output_item.added",
              output_index: 1,
              item: { id: "message_first", type: "message" },
            }),
            sse(final),
          ].join(""),
        ),
      );
      expect(JSON.parse(result[2].data)).toEqual({
        ...final,
        response: {
          ...final.response,
          output: [
            { ...final.response.output[0], id: "reasoning_first" },
            { ...final.response.output[1], id: "message_first" },
          ],
        },
      });
    },
  );

  it("preserves SSE metadata, heartbeats, multiline data, and UTF-8 across CRLF byte boundaries", async () => {
    const input =
      ': keep-alive\r\n\r\nretry: 1200\r\n\r\nid: transport-123\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "output_index":0,"item_id":"first","delta":"中文🙂"}\r\n\r\n' +
      sse({
        type: "response.output_text.done",
        output_index: 0,
        item_id: "second",
        text: "中文🙂",
      }).replace(/\n/g, "\r\n") +
      "data: [DONE]";
    const output = await normalize(input, 1);
    const events = parseEvents(output);
    expect(output).toContain(": keep-alive\n\n");
    expect(output).toContain("retry: 1200\n\n");
    expect(events[0]).toMatchObject({
      id: "transport-123",
      event: "response.output_text.delta",
    });
    expect(JSON.parse(events[0].data)).toMatchObject({
      item_id: "first",
      delta: "中文🙂",
    });
    expect(JSON.parse(events[1].data)).toMatchObject({
      item_id: "first",
      text: "中文🙂",
    });
    expect(events[2].data).toBe("[DONE]");
    expect(events).toHaveLength(3);
  });

  it("leaves already consistent events and unrelated or malformed payloads unchanged", async () => {
    const input = [
      sse({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "stable", type: "message" },
      }),
      sse({
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "stable",
        delta: "Hi",
      }),
      sse({
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "stable", type: "message" },
      }),
      sse({
        type: "custom.event",
        output_index: 0,
        item_id: "custom-id",
        data: { id: "nested-id" },
      }),
      sse({
        type: "response.output_text.delta",
        output_index: -1,
        item_id: "invalid-index",
      }),
      sse({ type: "response.output_text.delta", item_id: "missing-index" }),
      sse({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message" },
      }),
      sse({ type: "response.output_item.added", output_index: 2, item: null }),
      "data: {invalid json}\n\n",
      "data: null\n\n",
      "data: []\n\n",
      "data: [DONE]\n\n",
    ].join("");
    expect(await normalize(input)).toBe(input);
  });

  it("does not share mappings across concurrent streams or successive responses", async () => {
    const first = sse({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "first-response" },
    });
    const next =
      sse({
        type: "response.created",
        response: { id: "next-response", output: [] },
      }) +
      sse({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "next-item" },
      }) +
      sse({
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "next-delta",
        delta: "Next",
      });
    const other =
      sse({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "other-item" },
      }) +
      sse({
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "other-delta",
        delta: "Other",
      });
    const [one, two] = await Promise.all([
      normalize(first + next),
      normalize(other),
    ]);
    expect(JSON.parse(parseEvents(one).at(-1)!.data).item_id).toBe("next-item");
    expect(JSON.parse(parseEvents(two).at(-1)!.data).item_id).toBe(
      "other-item",
    );
  });

  it("forwards a delta before upstream completion without buffering the whole response", async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
      },
    })
      .pipeThrough(createResponsesItemIdNormalizer())
      .getReader();
    const event = sse({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "early",
      delta: "Now",
    });
    upstream.enqueue(new TextEncoder().encode(event));
    try {
      expect(await reader.read()).toEqual({ done: false, value: event });
    } finally {
      await reader.cancel();
    }
  });
});
