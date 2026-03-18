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
      const openaiRequest = convertAnthropicToOpenAI(requestBody);

      if (isStream) {
        // --- Streaming ---
        const copilotResponse = await client.chatCompletionStream(openaiRequest);

        if (!copilotResponse.body) {
          return c.json(
            { error: { type: "api_error", message: "No response body from Copilot API" } },
            502,
          );
        }

        // Estimate input tokens (rough: ~4 chars per token)
        const inputEstimate = Math.ceil(JSON.stringify(requestBody).length / 4);

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
