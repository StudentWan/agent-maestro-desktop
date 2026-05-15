/**
 * Claude Code plugin — packages everything Claude-specific behind the
 * AgentPlugin contract.
 *
 * Anything outside this directory should consume Claude functionality
 * exclusively through this plugin. If you find yourself importing from
 * `src/agents/claude/...` directly anywhere outside this folder (other
 * than this index), you've broken the per-agent boundary — extend the
 * AgentPlugin contract instead.
 */
import type { Hono } from "hono";
import type { CopilotClient } from "../../copilot/client";
import type { TokenManager } from "../../copilot/token-manager";
import type { AgentModelInfo, AgentPlugin } from "../types";
import { CopilotAnthropicClient } from "./anthropic-client";
import {
  applyClaudeConfig,
  getClaudeConfigSnippet,
  removeClaudeConfig,
  writeModelToClaudeConfig,
} from "./local-config";
import { fetchAvailableModels } from "./models";
import {
  CLAUDE_VERIFY_MARKER_COMMAND,
  buildRemoveConfigScript,
  buildUpdateModelScript,
  buildWriteConfigScript,
  buildWriteOnboardingScript,
} from "./remote-config";
import { registerCountTokensRoute } from "./routes/count-tokens";
import { registerMessagesRoute } from "./routes/messages";
import { registerModelsRoutes } from "./routes/models";

export const claudePlugin: AgentPlugin = {
  id: "claude",
  displayName: "Claude Code",
  /**
   * Claude routes mount at `/v1/...` (Anthropic Messages API native paths)
   * — no prefix, because Claude Code expects them at the root. Codex uses
   * `/codex/v1/...` so the two never collide.
   */
  routePrefix: "",
  modelHint: "Claude Code will use this model",

  registerRoutes(app: Hono, getClient: () => CopilotClient | null): void {
    registerMessagesRoute(app, () => {
      const client = getClient();
      if (!client) return null;
      return {
        chat: client,
        anthropic: new CopilotAnthropicClient(client.getTokenManager()),
      };
    });
    registerCountTokensRoute(app);
    registerModelsRoutes(app);
  },

  async fetchModels(tokenManager: TokenManager): Promise<AgentModelInfo[]> {
    return fetchAvailableModels(tokenManager);
  },

  localConfig: {
    apply: applyClaudeConfig,
    remove: removeClaudeConfig,
    writeModel: writeModelToClaudeConfig,
    getSnippet: getClaudeConfigSnippet,
  },

  remoteConfig: {
    /**
     * Claude is the legacy critical path: failure to write the remote
     * Claude config tears down the codespace tunnel (preserves today's
     * behaviour). Future plugins (e.g. Codex) flip this to false so
     * additive failures don't regress Claude UX.
     */
    criticalForTunnel: true,
    buildWriteScript: buildWriteConfigScript,
    buildPostWriteScript: () => buildWriteOnboardingScript(),
    buildVerifyMarkerCommand: () => CLAUDE_VERIFY_MARKER_COMMAND,
    buildUpdateModelScript,
    buildRemoveScript: buildRemoveConfigScript,
  },
};
