import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { CopilotClient } from "../../../copilot/client";
import type { CopilotResponsesClient } from "../responses-client";
import { createResponsesItemIdNormalizer } from "../responses-stream";
import { CopilotUpstreamError } from "../../../copilot/upstream-error";
import { convertResponsesToOpenAI } from "../converter/responses-to-openai";
import { convertOpenAIToResponses } from "../converter/openai-to-responses";
import { createResponsesStreamTransformer } from "../converter/stream-transformer";
import {
  getSupportedReasoningEfforts,
  markModelRequiresChatCompletions,
  prefersResponsesEndpoint,
  resolveCodexReasoningEffort,
} from "../models";
import type { ResponsesRequest } from "../converter/types";
import type { CopilotCompletionRequest } from "../../../copilot/types";

export interface CodexResponsesServices {
  responses: Pick<CopilotResponsesClient, "createResponse" | "createResponseStream">;
  chat?: Pick<CopilotClient, "chatCompletion" | "chatCompletionStream">;
  showGeminiReasoning?: boolean;
}

function resolveServices(
  raw: CodexResponsesServices | CopilotResponsesClient | null,
): CodexResponsesServices | null {
  if (!raw) return null;
  if ("responses" in raw) return raw;
  return { responses: raw };
}

function shouldFallbackToChatCompletions(error: unknown): boolean {
  if (!(error instanceof CopilotUpstreamError)) return false;
  if (error.status !== 400 && error.status !== 404) return false;
  const text = `${error.message}\n${error.body}`.toLowerCase();
  return (
    text.includes("unsupported_api_for_model") ||
    text.includes("not accessible via the /responses endpoint") ||
    text.includes("not supported on /responses")
  );
}

function summarizeRequestShape(body: ResponsesRequest): string {
  const keys = Object.keys(body);
  const inputTypes = Array.isArray(body.input)
    ? Array.from(
        new Set(
          body.input.map((i) =>
            i && typeof i === "object"
              ? (i.type ?? `role:${(i as { role?: string }).role ?? "unknown"}`)
              : typeof i,
          ),
        ),
      )
    : [typeof body.input];
  const toolTypes = Array.isArray(body.tools)
    ? Array.from(
        new Set(
          body.tools.map((t) =>
            t && typeof t === "object" ? (t.type ?? "unknown") : typeof t,
          ),
        ),
      )
    : [];
  return `keys=[${keys.join(",")}] inputTypes=[${inputTypes.join(",")}] toolTypes=[${toolTypes.join(",")}]`;
}

function isReasoningEffortRejectedError(error: unknown): boolean {
  if (!(error instanceof CopilotUpstreamError) || error.status !== 400) {
    return false;
  }
  const text = `${error.message}\n${error.body}`.toLowerCase();
  return text.includes("reasoning_effort");
}

function buildChatFallbackAttempts(
  baseRequest: CopilotCompletionRequest,
  modelId: string,
): CopilotCompletionRequest[] {
  const attempts: CopilotCompletionRequest[] = [baseRequest];
  const supportedEfforts = getSupportedReasoningEfforts(modelId);
  const canUseLowEffort = Boolean(supportedEfforts?.includes("low"));

  if (
    canUseLowEffort &&
    baseRequest.reasoning_effort !== "low"
  ) {
    attempts.push({ ...baseRequest, reasoning_effort: "low" });
  }

  if (
    Array.isArray(baseRequest.tools) &&
    baseRequest.tools.length > 0 &&
    (baseRequest.tool_choice === undefined || baseRequest.tool_choice === "auto")
  ) {
    attempts.push({
      ...baseRequest,
      ...(canUseLowEffort ? { reasoning_effort: "low" } : {}),
      tool_choice: "required",
    });
  }

  return attempts;
}

function isSubstantiveTransformedChunk(chunk: string): boolean {
  return (
    chunk.includes('"type":"response.output_text.delta"') ||
    chunk.includes('"type":"function_call"') ||
    chunk.includes('"type":"response.completed"')
  );
}

/**
 * Register POST /codex/v1/responses — the OpenAI Responses API endpoint
 * Codex CLI calls.
 *
 * Forwarding strategy: pass the body through to Copilot's native
 * `/responses` endpoint. Streamed output item IDs are normalized so Codex
 * can reconcile deltas with completed items. We don't translate to ChatCompletions
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
  getClient: () => CodexResponsesServices | CopilotResponsesClient | null,
): void {
  app.post("/codex/v1/responses", async (c: Context) => {
    const services = resolveServices(getClient());
    if (!services) {
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

    const handleViaChatCompletions = async () => {
      if (!services.chat) {
        throw new Error("ChatCompletions fallback client is not configured");
      }
      const chatClient = services.chat;
      const reasoningEffort = resolveCodexReasoningEffort(
        originalModel,
        requestBody.reasoning?.effort,
      );
      const baseRequest = convertResponsesToOpenAI(requestBody, { reasoningEffort });
      const attempts = buildChatFallbackAttempts(baseRequest, originalModel);

      const openStreamWithReasoningFallback = async (
        req: CopilotCompletionRequest,
      ): Promise<Response> => {
        try {
          return await chatClient.chatCompletionStream(req);
        } catch (error) {
          if (req.reasoning_effort && isReasoningEffortRejectedError(error)) {
            const { reasoning_effort: _, ...withoutEffort } = req;
            return await chatClient.chatCompletionStream(withoutEffort);
          }
          throw error;
        }
      };

      const completeWithReasoningFallback = async (
        req: CopilotCompletionRequest,
      ) => {
        try {
          return await chatClient.chatCompletion(req);
        } catch (error) {
          if (req.reasoning_effort && isReasoningEffortRejectedError(error)) {
            const { reasoning_effort: _, ...withoutEffort } = req;
            return await chatClient.chatCompletion(withoutEffort);
          }
          throw error;
        }
      };

      if (isStream) {
        const inputEstimate = Math.ceil(JSON.stringify(requestBody).length / 6);
        c.set("loggedInputTokens", inputEstimate);
        const emitReasoning =
          services.showGeminiReasoning !== false || !/^(google\/)?gemini-/i.test(originalModel);

        const firstUpstream = await openStreamWithReasoningFallback(attempts[0]);
        if (!firstUpstream.body) {
          return c.json(
            {
              error: {
                type: "api_error",
                code: "upstream_empty_body",
                message: "No response body from Copilot ChatCompletions API",
              },
            },
            502,
          );
        }

        return stream(c, async (s) => {
          c.header("Content-Type", "text/event-stream");
          c.header("Cache-Control", "no-cache");
          c.header("Connection", "keep-alive");

          let lastFailureChunks: string[] = [];

          for (let attemptIdx = 0; attemptIdx < attempts.length; attemptIdx++) {
            let upstream: Response;
            try {
              upstream =
                attemptIdx === 0
                  ? firstUpstream
                  : await openStreamWithReasoningFallback(attempts[attemptIdx]);
            } catch (error) {
              console.warn(
                `[Codex Responses Route] ChatCompletions recovery attempt ${attemptIdx + 1} failed to connect:`,
                error instanceof Error ? error.message : String(error),
              );
              continue;
            }

            if (!upstream.body) continue;

            const reader = upstream.body
              .pipeThrough(createResponsesStreamTransformer(originalModel, { emitReasoning }))
              .getReader();

            const preOutputBuffer: string[] = [];
            let flushed = false;
            let sawFailure = false;

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (flushed) {
                  await s.write(value);
                  continue;
                }

                preOutputBuffer.push(value);
                if (value.includes('"type":"response.failed"')) {
                  sawFailure = true;
                  continue;
                }
                if (isSubstantiveTransformedChunk(value)) {
                  flushed = true;
                  for (const buffered of preOutputBuffer) {
                    await s.write(buffered);
                  }
                  preOutputBuffer.length = 0;
                }
              }
            } catch (error) {
              console.error("[Codex Responses Route] ChatCompletions stream error:", error);
              if (flushed) return;
              sawFailure = true;
            } finally {
              reader.releaseLock();
            }

            if (flushed) {
              return;
            }

            lastFailureChunks = preOutputBuffer;
            if (!sawFailure) {
              for (const buffered of preOutputBuffer) {
                await s.write(buffered);
              }
              return;
            }

            if (attemptIdx + 1 < attempts.length) {
              console.warn(
                `[Codex Responses Route] Empty ChatCompletions stream for model=${originalModel} (attempt ${attemptIdx + 1}/${attempts.length}); retrying with fallback parameters`,
              );
            }
          }

          for (const chunk of lastFailureChunks) {
            await s.write(chunk);
          }
        });
      }

      let lastResponsesPayload = convertOpenAIToResponses(
        await completeWithReasoningFallback(attempts[0]),
        originalModel,
      );
      for (let attemptIdx = 1; attemptIdx < attempts.length; attemptIdx++) {
        if (lastResponsesPayload.output.length > 0) break;
        console.warn(
          `[Codex Responses Route] Empty ChatCompletions response for model=${originalModel} (attempt ${attemptIdx}/${attempts.length}); retrying with fallback parameters`,
        );
        const retryCompletion = await completeWithReasoningFallback(attempts[attemptIdx]);
        lastResponsesPayload = convertOpenAIToResponses(retryCompletion, originalModel);
      }

      if (lastResponsesPayload.usage) {
        c.set("loggedInputTokens", lastResponsesPayload.usage.input_tokens);
        c.set("loggedOutputTokens", lastResponsesPayload.usage.output_tokens);
      }
      return c.json(lastResponsesPayload);
    };

    const handleViaNativeResponses = async () => {
      if (isStream) {
        const upstream = await services.responses.createResponseStream(requestBody);

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

        const reader = upstream.body
          .pipeThrough(createResponsesItemIdNormalizer())
          .getReader();

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
          } finally {
            reader.releaseLock();
          }
        });
      }

      const responseJson = (await services.responses.createResponse(requestBody)) as {
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
    };

    try {
      const useNativeResponses =
        !services.chat || prefersResponsesEndpoint(originalModel);

      if (useNativeResponses) {
        try {
          return await handleViaNativeResponses();
        } catch (error) {
          if (services.chat && shouldFallbackToChatCompletions(error)) {
            console.warn(
              `[Codex Responses Route] Model "${originalModel}" rejected by /responses; falling back to /chat/completions`,
            );
            markModelRequiresChatCompletions(originalModel);
            return await handleViaChatCompletions();
          }
          throw error;
        }
      }

      return await handleViaChatCompletions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[Codex Responses Route] Error (model=${originalModel}, ${summarizeRequestShape(requestBody)}):`,
        message,
      );
      c.set("loggedError", message);
      if (error instanceof CopilotUpstreamError) {
        c.set("loggedUpstreamError", { status: error.status, body: error.body });
      }

      // Detect context-window overflow from upstream. Treats both an
      // explicit 413 (request body too large to even parse) and any
      // 4xx/5xx whose body mentions context-length/payload-size as a
      // signal Codex CLI should auto-compact. Mirrors the same treatment
      // we give Claude in `src/agents/claude/routes/messages.ts` for
      // context_length_exceeded — without this Codex just dies with a
      // raw "server_error" on long sessions and loses the conversation.
      const isContextExceeded = isContextWindowExceededError(error, message);
      const errorCode = isContextExceeded
        ? "context_length_exceeded"
        : "server_error";
      const errorMessage = isContextExceeded
        ? "Model context window exceeded; compact and retry."
        : message;

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
              error: { code: errorCode, message: errorMessage },
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

      if (isContextExceeded) {
        // For non-streaming, return a 200 with status:"incomplete" carrying
        // the same code so Codex's non-stream client treats it as a clean
        // compaction signal rather than a transport-level 502 (which it
        // logs and aborts on).
        return c.json({
          id: `resp_${Date.now()}`,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "incomplete",
          incomplete_details: { reason: "context_length_exceeded" },
          model: originalModel,
          output: [],
          error: { code: errorCode, message: errorMessage },
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

const CONTEXT_EXCEEDED_PATTERNS =
  /context.*(length|window|limit)|too many tokens|payload[\s_-]?too[\s_-]?large|prompt.*too.*long|max(?:imum)?[\s_-]?tokens|exceeds[\s_-]?(?:the[\s_-]?)?(?:max|context)/i;

function isContextWindowExceededError(error: unknown, message: string): boolean {
  if (error instanceof CopilotUpstreamError) {
    if (error.status === 413) return true;
    if (CONTEXT_EXCEEDED_PATTERNS.test(error.body)) return true;
  }
  return CONTEXT_EXCEEDED_PATTERNS.test(message);
}
