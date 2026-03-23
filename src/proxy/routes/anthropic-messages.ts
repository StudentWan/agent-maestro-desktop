import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { CopilotClient } from "../../copilot/client";
import { convertAnthropicToOpenAI } from "../../converter/anthropic-to-openai";
import { convertOpenAIToAnthropic } from "../../converter/openai-to-anthropic";
import { createStreamTransformer } from "../../converter/stream-transformer";
import type { AnthropicRequest } from "../../converter/types";

/**
 * Register the POST /v1/messages route (Anthropic Messages API)
 */
export function registerMessagesRoute(app: Hono, getClient: () => CopilotClient | null) {
  app.post("/v1/messages", async (c: Context) => {
    const client = getClient();
    if (!client) {
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

    try {
      // Convert Anthropic request → OpenAI/Copilot request
      const headers: Record<string, string | undefined> = {
        "anthropic-beta": c.req.header("anthropic-beta"),
      };
      const openaiRequest = convertAnthropicToOpenAI(requestBody, headers);

      if (isStream) {
        // --- Streaming ---
        const copilotResponse = await client.chatCompletionStream(openaiRequest);

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
        const copilotResponse = await client.chatCompletion(openaiRequest);

        // Convert OpenAI response → Anthropic response
        const anthropicResponse = convertOpenAIToAnthropic(copilotResponse, originalModel);

        return c.json(anthropicResponse);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Messages Route] Error:", message);

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
