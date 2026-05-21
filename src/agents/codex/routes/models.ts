import { Hono } from "hono";
import type { TokenManager } from "../../../copilot/token-manager";
import { fetchAvailableCodexModels } from "../models";

/**
 * GET /codex/v1/models — list models Codex CLI may select.
 *
 * Codex CLI calls this to populate its model picker / verify the selected
 * model still exists. Returns the OpenAI models-list shape so Codex's
 * existing parser works without changes.
 *
 * The route delegates to the Codex-side filter in `models.ts` rather than
 * importing the generic Copilot models fetcher directly — that keeps any
 * future "which models does Codex accept" tweaks contained inside
 * `src/agents/codex/`.
 */
export function registerCodexModelsRoute(
  app: Hono,
  getTokenManager: () => TokenManager | null,
): void {
  app.get("/codex/v1/models", async (c) => {
    const tokenManager = getTokenManager();
    if (!tokenManager) {
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

    try {
      const models = await fetchAvailableCodexModels(tokenManager);
      const created = Math.floor(Date.now() / 1000);
      return c.json({
        object: "list",
        data: models.map((m) => ({
          id: m.id,
          object: "model",
          created,
          owned_by: "openai",
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Codex Models Route] Error:", message);
      return c.json(
        {
          error: {
            type: "api_error",
            code: "models_fetch_failed",
            message: `Failed to fetch Codex models: ${message}`,
          },
        },
        502,
      );
    }
  });
}
