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
      const body = await c.req.json() as { model?: string };
      // Stash model on context so the request-logger middleware can show it
      // instead of "unknown". Claude Code hits this endpoint constantly for
      // context-window estimation; without this, the request log is mostly
      // noise.
      if (typeof body.model === "string" && body.model.length > 0) {
        c.set("loggedModel", body.model);
      }
      const bodyStr = JSON.stringify(body);

      // Rough estimate: ~6 characters per token (conservative to avoid over-counting;
      // JSON structure chars inflate the raw length relative to actual token count)
      const inputTokens = Math.ceil(bodyStr.length / 6);
      c.set("loggedInputTokens", inputTokens);

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
