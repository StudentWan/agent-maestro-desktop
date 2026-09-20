import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerResponsesRoute } from "../routes/responses";
import { createRequestLogger } from "../../../proxy/middleware/request-logger";
import { CopilotUpstreamError } from "../../../copilot/upstream-error";
import type { CopilotResponsesClient } from "../responses-client";

function makeClient(overrides: Partial<{
  createResponse: ReturnType<typeof vi.fn>;
  createResponseStream: ReturnType<typeof vi.fn>;
}>): CopilotResponsesClient {
  return {
    createResponse: overrides.createResponse ?? vi.fn(),
    createResponseStream: overrides.createResponseStream ?? vi.fn(),
  } as unknown as CopilotResponsesClient;
}

describe("codex responses route", () => {
  it("returns 401 when no client is wired up", async () => {
    const app = new Hono();
    registerResponsesRoute(app, () => null);

    const res = await app.request("/codex/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: "hi" }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe("authentication_error");
  });

  it("returns 400 on invalid JSON", async () => {
    const app = new Hono();
    registerResponsesRoute(app, () => makeClient({}));

    const res = await app.request("/codex/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  it("rejects previous_response_id with HTTP 400 (stateless proxy)", async () => {
    const app = new Hono();
    const createResponse = vi.fn();
    registerResponsesRoute(app, () => makeClient({ createResponse }));

    const res = await app.request("/codex/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hi",
        previous_response_id: "resp_old",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("unsupported_parameter");
    expect(body.error.param).toBe("previous_response_id");
    // Crucially: we must NOT have made an upstream call.
    expect(createResponse).not.toHaveBeenCalled();
  });

  it("forwards a non-streaming request to the responses client and returns its JSON unchanged", async () => {
    const app = new Hono();
    const createResponse = vi.fn().mockResolvedValue({
      id: "resp_xyz",
      object: "response",
      output: [],
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    registerResponsesRoute(app, () => makeClient({ createResponse }));

    const res = await app.request("/codex/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [{ role: "user", content: "hi" }],
        reasoning: { effort: "high" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("resp_xyz");
    // Body forwarded verbatim (our shape preserved, no ChatCompletions
    // translation happened).
    expect(createResponse).toHaveBeenCalledTimes(1);
    const forwarded = createResponse.mock.calls[0][0];
    expect(forwarded.model).toBe("gpt-5.5");
    expect(forwarded.input).toEqual([{ role: "user", content: "hi" }]);
    expect(forwarded.reasoning).toEqual({ effort: "high" });
  });

  it("forwards a streaming request and pipes the SSE body through unchanged", async () => {
    const app = new Hono();
    const upstreamSse =
      `event: response.created\ndata: {"type":"response.created","sequence_number":0}\n\n` +
      `event: response.completed\ndata: {"type":"response.completed","sequence_number":1}\n\n`;

    const upstream = {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(upstreamSse));
          controller.close();
        },
      }),
    } as unknown as Response;

    const createResponseStream = vi.fn().mockResolvedValue(upstream);
    registerResponsesRoute(app, () => makeClient({ createResponseStream }));

    const res = await app.request("/codex/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hi",
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    // Verbatim pass-through: the bytes the upstream emitted are exactly what
    // Codex CLI receives. No converter rewriting.
    expect(text).toBe(upstreamSse);
    expect(createResponseStream).toHaveBeenCalledTimes(1);
  });

  it("keeps streamed and completed messages and tool calls on the same item IDs", async () => {
    const message = {
      type: "message",
      role: "assistant",
      phase: "commentary",
      status: "completed",
      content: [{ type: "output_text", text: "正在检查。" }],
      internal_chat_message_metadata_passthrough: "opaque-metadata",
    };
    const tool = {
      type: "function_call",
      name: "diagnostic_noop",
      call_id: "call_original",
      arguments: "{}",
      status: "completed",
    };
    const events = [
      {
        type: "response.created",
        response: { id: "resp_original", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          ...message,
          id: "message_first",
          content: [],
          status: "in_progress",
        },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: "message_delta",
        delta: "正在检查。",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...message, id: "message_done" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          ...tool,
          id: "tool_first",
          arguments: "",
          status: "in_progress",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "tool_delta",
        delta: "{}",
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { ...tool, id: "tool_done" },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_original",
          output: [
            { ...message, id: "message_final" },
            { ...tool, id: "tool_final" },
          ],
          usage: { input_tokens: 12, output_tokens: 5 },
        },
      },
    ].map((event, sequence_number) => ({ ...event, sequence_number }));
    const bytes = new TextEncoder().encode(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += 7) {
            controller.enqueue(bytes.slice(offset, offset + 7));
          }
          controller.close();
        },
      }),
    );
    const app = new Hono();
    const createResponseStream = vi.fn().mockResolvedValue(upstream);
    registerResponsesRoute(app, () => makeClient({ createResponseStream }));

    const res = await app.request("/codex/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-astra",
        input: "test",
        stream: true,
      }),
    });
    const actual = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));

    expect(actual[2].item_id).toBe("message_first");
    expect(actual[3].item).toEqual({ ...message, id: "message_first" });
    expect(actual[5].item_id).toBe("tool_first");
    expect(actual[6].item).toEqual({ ...tool, id: "tool_first" });
    expect(actual[7].response).toEqual({
      id: "resp_original",
      output: [
        { ...message, id: "message_first" },
        { ...tool, id: "tool_first" },
      ],
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    expect(actual.map((event) => event.sequence_number)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(actual[2].delta).toBe("正在检查。");
    expect(createResponseStream).toHaveBeenCalledTimes(1);
  });

  it("emits a synthetic response.failed SSE event when the upstream throws mid-stream setup", async () => {
    const app = new Hono();
    const createResponseStream = vi
      .fn()
      .mockRejectedValue(new Error("Copilot Responses API stream error (400): boom"));
    registerResponsesRoute(app, () => makeClient({ createResponseStream }));

    const res = await app.request("/codex/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hi",
        stream: true,
      }),
    });

    // We hand the failure back as SSE so Codex CLI's parser surfaces a
    // useful message instead of "stream disconnected before completion".
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.failed");
    expect(text).toContain("server_error");
    expect(text).toContain("boom");
  });

  it("surfaces upstream response body on the request log entry when copilot returns non-200", async () => {
    const logCallback = vi.fn();
    const upstreamBody = '{"error":{"code":"upstream_unavailable"}}';
    const createResponse = vi
      .fn()
      .mockRejectedValue(
        new CopilotUpstreamError(
          "Copilot Responses API error (502)",
          502,
          upstreamBody,
        ),
      );

    const app = new Hono();
    app.use("*", createRequestLogger(logCallback));
    registerResponsesRoute(app, () => makeClient({ createResponse }));

    const res = await app.request("/codex/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hi",
      }),
    });

    expect(res.status).toBe(502);
    expect(logCallback).toHaveBeenCalledTimes(1);
    const entry = logCallback.mock.calls[0][0];
    expect(entry.upstreamError).toEqual({ status: 502, body: upstreamBody });
    expect(entry.error).toContain("Copilot Responses API error (502)");
  });

  it("maps upstream HTTP 413 to a streaming response.failed with context_length_exceeded", async () => {
    const app = new Hono();
    const createResponseStream = vi
      .fn()
      .mockRejectedValue(
        new CopilotUpstreamError(
          "Copilot Responses API stream error (413)",
          413,
          "<html>Payload too large</html>",
        ),
      );
    registerResponsesRoute(app, () => makeClient({ createResponseStream }));

    const res = await app.request("/codex/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: "hi", stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: response.failed");
    expect(text).toContain("context_length_exceeded");
    // Must NOT mention server_error — that's the old generic code Codex
    // doesn't react to.
    expect(text).not.toMatch(/"code"\s*:\s*"server_error"/);
  });

  it("maps body-pattern context-length errors to context_length_exceeded (non-413 status)", async () => {
    const app = new Hono();
    const createResponse = vi
      .fn()
      .mockRejectedValue(
        new CopilotUpstreamError(
          "Copilot Responses API error (400)",
          400,
          '{"error":{"message":"This model\\u0027s maximum context length is 128000 tokens. Your messages resulted in 200000 tokens."}}',
        ),
      );
    registerResponsesRoute(app, () => makeClient({ createResponse }));

    const res = await app.request("/codex/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: "hi" }),
    });

    // Non-stream uses 200 + status:incomplete so Codex's non-stream client
    // treats it as a clean compaction signal.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("incomplete");
    expect(body.incomplete_details).toEqual({
      reason: "context_length_exceeded",
    });
    expect(body.error?.code).toBe("context_length_exceeded");
  });

  it("leaves non-context upstream errors as server_error / 502", async () => {
    const app = new Hono();
    const createResponseStream = vi
      .fn()
      .mockRejectedValue(
        new CopilotUpstreamError(
          "Copilot Responses API stream error (500)",
          500,
          "internal server error",
        ),
      );
    registerResponsesRoute(app, () => makeClient({ createResponseStream }));

    const res = await app.request("/codex/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: "hi", stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"code":"server_error"');
    expect(text).not.toContain("context_length_exceeded");
  });
});
