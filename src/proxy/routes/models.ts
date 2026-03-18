import { Hono } from "hono";
import { mapModelName } from "../../converter/model-mapper";

/**
 * GET /v1/models - List available models (Anthropic format)
 */
export function registerModelsRoutes(app: Hono) {
  app.get("/v1/models", (c) => {
    const models = [
      {
        id: "claude-opus-4-6",
        object: "model",
        created: Date.now(),
        owned_by: "anthropic",
      },
      {
        id: "claude-sonnet-4-6",
        object: "model",
        created: Date.now(),
        owned_by: "anthropic",
      },
      {
        id: "claude-haiku-4-5-20251001",
        object: "model",
        created: Date.now(),
        owned_by: "anthropic",
      },
    ];

    return c.json({ object: "list", data: models });
  });
}
