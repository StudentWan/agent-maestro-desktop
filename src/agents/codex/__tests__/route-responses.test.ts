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
