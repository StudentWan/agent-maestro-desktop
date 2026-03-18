import { Hono } from "hono";

/**
 * POST /v1/messages/count_tokens - Count input tokens
 *
 * Returns an approximate token count (rough estimation since we don't have
 * the actual tokenizer for the underlying model).
 */
export function registerCountTokensRoute(app: Hono) {
  app.post("/v1/messages/count_tokens", async (c) => {
    try {
      const body = await c.req.json();
      const bodyStr = JSON.stringify(body);

      // Rough estimate: ~4 characters per token
      const inputTokens = Math.ceil(bodyStr.length / 4);

      return c.json({ input_tokens: inputTokens });
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
  });
}
