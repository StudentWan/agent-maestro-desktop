import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerResponsesRoute } from "../routes/responses";
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
});
