import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { CopilotClient } from "../../../copilot/client";
import type { CopilotAnthropicClient } from "../anthropic-client";
import { convertAnthropicToOpenAI } from "../converter/anthropic-to-openai";
import { convertOpenAIToAnthropic } from "../converter/openai-to-anthropic";
import { createStreamTransformer } from "../converter/stream-transformer";
import type { AnthropicRequest } from "../converter/types";

/**
 * Subset of services this route needs. Bundled into one object so the
 * plugin can inject both clients (Anthropic Messages for Claude models,
 * generic ChatCompletions for the OpenAI-compatible fallback path) with a
 * single getter.
 */
export interface ClaudeMessagesServices {
  chat: Pick<CopilotClient, "chatCompletion" | "chatCompletionStream">;
  anthropic: Pick<CopilotAnthropicClient, "messages" | "messagesStream">;
}

/**
 * Register the POST /v1/messages route (Anthropic Messages API)
 */
export function registerMessagesRoute(
  app: Hono,
  getServices: () => ClaudeMessagesServices | null,
) {
  app.post("/v1/messages", async (c: Context) => {
    const services = getServices();
    if (!services) {
      return c.json(
        {
          error: {
            type: "authentication_error",
            message: "Not authenticated. Please login via the Agent Maestro Desktop app.",
          },
        },
        401,
      );
    }

    let requestBody: AnthropicRequest;
    try {
      requestBody = (await c.req.json()) as AnthropicRequest;
    } catch {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "Invalid JSON in request body",
          },
        },
        400,
      );
    }

    const originalModel = requestBody.model;
    const isStream = requestBody.stream === true;

    // Surface metadata to the request-logger middleware (which runs after us).
    c.set("loggedModel", originalModel);
    c.set("loggedStream", isStream);
    const thinkingLevel = resolveLoggedThinkingLevel(requestBody);
    if (thinkingLevel) {
      c.set("loggedThinkingLevel", thinkingLevel);
    }

    try {
      const headers: Record<string, string | undefined> = {
        "anthropic-beta": c.req.header("anthropic-beta"),
      };

      if (isClaudeModel(originalModel)) {
        if (isStream) {
          const copilotResponse = await services.anthropic.messagesStream(requestBody, {
            anthropicBeta: headers["anthropic-beta"],
          });

          if (!copilotResponse.body) {
            return c.json(
              { error: { type: "api_error", message: "No response body from Copilot API" } },
              502,
            );
          }

          const inputEstimate = Math.ceil(JSON.stringify(requestBody).length / 6);
          c.set("loggedInputTokens", inputEstimate);

          const reader = copilotResponse.body.getReader();
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
              if (tail) {
                await s.write(tail);
              }
            } catch (error) {
              console.error("[Messages Route] Stream error:", error);
            } finally {
              reader.releaseLock();
            }
          });
        }

        const anthropicResponse = await services.anthropic.messages(requestBody, {
          anthropicBeta: headers["anthropic-beta"],
        });
        c.set("loggedInputTokens", anthropicResponse.usage.input_tokens);
        c.set("loggedOutputTokens", anthropicResponse.usage.output_tokens);
        return c.json(anthropicResponse);
      }

      // Convert non-Claude Anthropic request → OpenAI/Copilot request
      const openaiRequest = convertAnthropicToOpenAI(requestBody, headers);

      if (isStream) {
        // --- Streaming ---
        const copilotResponse = await services.chat.chatCompletionStream(openaiRequest);

        if (!copilotResponse.body) {
          return c.json(
            { error: { type: "api_error", message: "No response body from Copilot API" } },
            502,
          );
        }

        // Estimate input tokens (rough: ~6 chars per token, conservative to avoid over-counting)
        const inputEstimate = Math.ceil(JSON.stringify(requestBody).length / 6);

        // Pipe through our transformer
        const transformer = createStreamTransformer(originalModel, inputEstimate);
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
            console.error("[Messages Route] Stream error:", error);
          }
        });
      } else {
        // --- Non-streaming ---
        const copilotResponse = await services.chat.chatCompletion(openaiRequest);

        // Convert OpenAI response → Anthropic response
        const anthropicResponse = convertOpenAIToAnthropic(copilotResponse, originalModel);

        return c.json(anthropicResponse);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Messages Route] Error:", message);
      c.set("loggedError", message);

      // Detect context window / context length exceeded errors from Copilot
      const isContextExceeded =
        /context.*(length|window|limit)|too many tokens/i.test(message);

      if (isContextExceeded) {
        const inputEstimate = Math.ceil(JSON.stringify(requestBody).length / 6);
        // Inflate to trigger Claude Code auto-compact
        const inflatedTokens = inputEstimate * 2;

        if (isStream) {
          return stream(c, async (s) => {
            c.header("Content-Type", "text/event-stream");
            c.header("Cache-Control", "no-cache");
            c.header("Connection", "keep-alive");

            const fmt = (event: string, data: unknown) =>
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

            await s.write(
              fmt("message_start", {
                type: "message_start",
                message: {
                  id: `msg_${Date.now()}`,
                  type: "message",
                  role: "assistant",
                  model: originalModel,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    cache_creation: null,
                    input_tokens: inflatedTokens,
                    output_tokens: 0,
                    cache_creation_input_tokens: null,
                    cache_read_input_tokens: null,
                    server_tool_use: null,
                    service_tier: "standard",
                  },
                },
              }),
            );
            await s.write(
              fmt("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: "model_context_window_exceeded",
                  stop_sequence: null,
                },
                usage: {
                  input_tokens: inflatedTokens,
                  output_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  server_tool_use: null,
                },
              }),
            );
            await s.write(fmt("message_stop", { type: "message_stop" }));
          });
        }

        return c.json({
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model: originalModel,
          content: [],
          stop_reason: "model_context_window_exceeded",
          stop_sequence: null,
          usage: {
            cache_creation: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            input_tokens: inflatedTokens,
            output_tokens: 0,
            server_tool_use: null,
            service_tier: null,
          },
        });
      }

      return c.json(
        {
          error: {
            type: "api_error",
            message: `Copilot API request failed: ${message}`,
          },
        },
        502,
      );
    }
  });
}

function isClaudeModel(model: string): boolean {
  return model.toLowerCase().includes("claude");
}

function resolveLoggedThinkingLevel(request: AnthropicRequest): string | undefined {
  const requestedEffort = request.output_config?.effort;
  if (typeof requestedEffort === "string" && requestedEffort.length > 0) {
    return requestedEffort;
  }

  const model = request.model.toLowerCase();
  if (model.includes("opus-4.7-xhigh")) {
    return "xhigh";
  }
  if (model.includes("opus-4.7-high")) {
    return "high";
  }
  if (model === "claude-opus-4.8" || model === "claude-opus-4-8") {
    return "medium";
  }

  if (!request.thinking) {
    return undefined;
  }

  if (request.thinking.type === "disabled") {
    return "off";
  }

  if (request.thinking.type === "enabled" || request.thinking.type === "adaptive") {
    return resolveThinkingEffort(request.model, request.thinking.budget_tokens);
  }

  return request.thinking.type;
}

function resolveThinkingEffort(model: string, budgetTokens: number | undefined): "low" | "medium" | "high" | "xhigh" {
  if (budgetTokens === undefined || !Number.isFinite(budgetTokens)) {
    return "medium";
  }
  if (supportsXHighThinkingBudget(model) && budgetTokens >= 30_000) {
    return "xhigh";
  }
  if (budgetTokens >= 16_000) {
    return "high";
  }
  if (budgetTokens >= 4_000) {
    return "medium";
  }
  return "low";
}

function supportsXHighThinkingBudget(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("opus-4.7-1m") || normalized.includes("opus-4.7-xhigh");
}
