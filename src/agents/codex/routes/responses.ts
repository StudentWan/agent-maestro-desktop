import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { CopilotResponsesClient } from "../responses-client";
import type { ResponsesRequest } from "../converter/types";

/**
 * Register POST /codex/v1/responses — the OpenAI Responses API endpoint
 * Codex CLI calls.
 *
 * Forwarding strategy: pass the body through to Copilot's native
 * `/responses` endpoint unchanged. We don't translate to ChatCompletions
 * because that path 400s for Responses-only models (gpt-5.5 et al.) with
 * `unsupported_api_for_model`. See `responses-client.ts` for the rationale.
 *
 * Mirrors the failure semantics of the Claude Messages route:
 *   - 401 when not authenticated
 *   - 400 on invalid JSON or rejected parameters (previous_response_id /
 *     conversation, since this proxy is stateless)
 *   - 502 on upstream errors in the non-streaming path
 *   - SSE-shaped error event in the streaming path so the Codex CLI parser
 *     surfaces something useful instead of just disconnecting
 *   - Sets logged{Model,Stream,InputTokens,OutputTokens} on the Hono
 *     context so request-logger can render the row
 */
export function registerResponsesRoute(
  app: Hono,
  getClient: () => CopilotResponsesClient | null,
): void {
  app.post("/codex/v1/responses", async (c: Context) => {
    const client = getClient();
    if (!client) {
      return c.json(
        {
          error: {
            type: "authentication_error",
            code: "not_authenticated",
            message:
              "Not authenticated. Please log in via the Agent Maestro Desktop app.",
          },
        },
        401,
      );
    }

    let requestBody: ResponsesRequest;
    try {
      requestBody = (await c.req.json()) as ResponsesRequest;
    } catch {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            code: "invalid_json",
            message: "Invalid JSON in request body",
          },
        },
        400,
      );
    }

    const originalModel = requestBody.model;
    const isStream = requestBody.stream === true;

    c.set("loggedModel", originalModel);
    c.set("loggedStream", isStream);
    const reasoningEffort = requestBody.reasoning?.effort;
    if (typeof reasoningEffort === "string" && reasoningEffort.length > 0) {
      c.set("loggedThinkingLevel", reasoningEffort);
    }

    if (requestBody.previous_response_id) {
      const message =
        "previous_response_id is not supported — Agent Maestro Desktop is stateless. Disable Codex's stored-conversation mode.";
      c.set("loggedError", message);
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            code: "unsupported_parameter",
            param: "previous_response_id",
            message,
          },
        },
        400,
      );
    }
    if (requestBody.conversation !== undefined && requestBody.conversation !== null) {
      const message =
        "conversation is not supported — Agent Maestro Desktop is stateless. Disable Codex's stored-conversation mode.";
      c.set("loggedError", message);
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            code: "unsupported_parameter",
            param: "conversation",
            message,
          },
        },
        400,
      );
    }

    try {
      if (isStream) {
        const upstream = await client.createResponseStream(requestBody);

        if (!upstream.body) {
          return c.json(
            {
              error: {
                type: "api_error",
                code: "upstream_empty_body",
                message: "No response body from Copilot Responses API",
              },
            },
            502,
          );
        }

        // Rough estimate so request-logger has something to show. The
        // upstream `response.completed` event carries the real usage; the
        // logger only needs a coarse number while the row is in flight.
        const inputEstimate = Math.ceil(JSON.stringify(requestBody).length / 6);
        c.set("loggedInputTokens", inputEstimate);

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();

        return stream(c, async (s) => {
          c.header("Content-Type", "text/event-stream");
          c.header("Cache-Control", "no-cache");
          c.header("Connection", "keep-alive");

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await s.write(decoder.decode(value, { stream: true }));
            }
            const tail = decoder.decode();
            if (tail) await s.write(tail);
          } catch (error) {
            console.error("[Codex Responses Route] Stream error:", error);
          } finally {
            reader.releaseLock();
          }
        });
      }

      const responseJson = (await client.createResponse(requestBody)) as {
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (responseJson.usage) {
        if (typeof responseJson.usage.input_tokens === "number") {
          c.set("loggedInputTokens", responseJson.usage.input_tokens);
        }
        if (typeof responseJson.usage.output_tokens === "number") {
          c.set("loggedOutputTokens", responseJson.usage.output_tokens);
        }
      }
      return c.json(responseJson);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Codex Responses Route] Error:", message);
      c.set("loggedError", message);

      if (isStream) {
        // Codex CLI is mid-SSE; emit a minimal `response.failed` event so
        // its parser surfaces the reason instead of "stream disconnected
        // before completion".
        return stream(c, async (s) => {
          c.header("Content-Type", "text/event-stream");
          c.header("Cache-Control", "no-cache");
          c.header("Connection", "keep-alive");
          const responseId = `resp_${Date.now()}`;
          const created = {
            type: "response.created",
            sequence_number: 0,
            response: {
              id: responseId,
              object: "response",
              created_at: Math.floor(Date.now() / 1000),
              status: "in_progress",
              model: originalModel,
              output: [],
              error: null,
            },
          };
          const failed = {
            type: "response.failed",
            sequence_number: 1,
            response: {
              id: responseId,
              object: "response",
              created_at: Math.floor(Date.now() / 1000),
              status: "failed",
              model: originalModel,
              output: [],
              error: { code: "server_error", message },
            },
          };
          await s.write(
            `event: response.created\ndata: ${JSON.stringify(created)}\n\n`,
          );
          await s.write(
            `event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`,
          );
        });
      }

      return c.json(
        {
          error: {
            type: "api_error",
            code: "upstream_error",
            message: `Copilot Responses API request failed: ${message}`,
          },
        },
        502,
      );
    }
  });
}
