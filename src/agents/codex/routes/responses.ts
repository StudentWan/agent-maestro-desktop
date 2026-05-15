import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { CopilotClient } from "../../../copilot/client";
import {
  buildResponsesFailureSSE,
  createResponsesStreamTransformer,
} from "../converter/stream-transformer";
import { convertOpenAIToResponses } from "../converter/openai-to-responses";
import {
  ResponsesRequestError,
  convertResponsesToOpenAI,
} from "../converter/responses-to-openai";
import type { ResponsesRequest } from "../converter/types";

/**
 * Register the POST /codex/v1/responses route — the OpenAI Responses API
 * endpoint that Codex CLI calls.
 *
 * Mirrors `src/agents/claude/routes/messages.ts`:
 *   - 401 when the proxy isn't authenticated yet
 *   - 400 on invalid JSON or rejected parameters (previous_response_id,
 *     conversation)
 *   - Always sets logged{Model,Stream,InputTokens,OutputTokens} on the
 *     Hono context so the request-logger middleware can render the row
 *   - Streams: pipe Copilot SSE through `createResponsesStreamTransformer`
 *     so Codex sees the proper Responses event sequence
 *   - Non-streaming: convert the single ChatCompletions response via
 *     `convertOpenAIToResponses`
 */
export function registerResponsesRoute(
  app: Hono,
  getClient: () => Pick<CopilotClient, "chatCompletion" | "chatCompletionStream"> | null,
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

    let openaiRequest;
    try {
      openaiRequest = convertResponsesToOpenAI(requestBody);
    } catch (error) {
      if (error instanceof ResponsesRequestError) {
        c.set("loggedError", error.message);
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              code: "unsupported_parameter",
              message: error.message,
            },
          },
          error.status as 400,
        );
      }
      throw error;
    }

    try {
      if (isStream) {
        const copilotResponse = await client.chatCompletionStream(openaiRequest);

        if (!copilotResponse.body) {
          return c.json(
            {
              error: {
                type: "api_error",
                code: "upstream_empty_body",
                message: "No response body from Copilot API",
              },
            },
            502,
          );
        }

        // Rough estimate matches Claude's route — request-logger needs SOME
        // input-token figure to render the row.
        const inputEstimate = Math.ceil(JSON.stringify(requestBody).length / 6);
        c.set("loggedInputTokens", inputEstimate);

        const transformer = createResponsesStreamTransformer(originalModel);
        const transformed = copilotResponse.body.pipeThrough(transformer);
        const reader = transformed.getReader();

        return stream(c, async (s) => {
          c.header("Content-Type", "text/event-stream");
          c.header("Cache-Control", "no-cache");
          c.header("Connection", "keep-alive");

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await s.write(value);
            }
          } catch (error) {
            console.error("[Codex Responses Route] Stream error:", error);
          }
        });
      }

      const copilotResponse = await client.chatCompletion(openaiRequest);
      const responsesResponse = convertOpenAIToResponses(
        copilotResponse,
        originalModel,
      );
      if (responsesResponse.usage) {
        c.set("loggedInputTokens", responsesResponse.usage.input_tokens);
        c.set("loggedOutputTokens", responsesResponse.usage.output_tokens);
      }
      return c.json(responsesResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Codex Responses Route] Error:", message);
      c.set("loggedError", message);

      if (isStream) {
        // Codex CLI is mid-SSE — it expects a `response.failed` event, not a
        // JSON body. Synthesize one directly so the client's parser stays
        // happy and surfaces the error to the user.
        return stream(c, async (s) => {
          c.header("Content-Type", "text/event-stream");
          c.header("Cache-Control", "no-cache");
          c.header("Connection", "keep-alive");
          await s.write(buildResponsesFailureSSE(originalModel, message));
        });
      }

      return c.json(
        {
          error: {
            type: "api_error",
            code: "upstream_error",
            message: `Copilot API request failed: ${message}`,
          },
        },
        502,
      );
    }
  });
}
