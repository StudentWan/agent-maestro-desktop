import { Hono } from "hono";
import type { TokenManager } from "../../../copilot/token-manager";
import { fetchAvailableModels } from "../models";

const FALLBACK_MODELS = [
  "claude-opus-4.8",
  "claude-opus-4-6",
  "claude-opus-4-6-1m",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

/**
 * GET /v1/models - List available models (Anthropic format)
 */
export function registerModelsRoutes(app: Hono, getTokenManager?: () => TokenManager | null) {
  app.get("/v1/models", async (c) => {
    const tokenManager = getTokenManager?.();
    if (tokenManager) {
      try {
        const availableModels = await fetchAvailableModels(tokenManager);
        if (availableModels.length > 0) {
          return c.json({ object: "list", data: availableModels.map((model) => toAnthropicModel(model.id)) });
        }
      } catch (error) {
        console.warn("[Claude Models Route] Failed to fetch dynamic Copilot models:", error);
      }
    }

    return c.json({ object: "list", data: FALLBACK_MODELS.map(toAnthropicModel) });
  });
}

function toAnthropicModel(id: string) {
  return {
    id,
    object: "model",
    created: Date.now(),
    owned_by: "anthropic",
  };
}
