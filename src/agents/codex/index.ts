/**
 * Codex CLI plugin — packages everything Codex-specific behind the
 * AgentPlugin contract.
 *
 * Symmetric with `src/agents/claude/index.ts`: nothing outside this
 * directory should import from `src/agents/codex/...` directly. Shared
 * infra (proxy server, codespace manager, IPC handlers, renderer)
 * consumes the exported `codexPlugin` through the `AgentPlugin`
 * interface only.
 */
import type { Hono } from "hono";
import type { CopilotClient } from "../../copilot/client";
import type { TokenManager } from "../../copilot/token-manager";
import type { AgentModelInfo, AgentPlugin } from "../types";
import {
  applyCodexConfig,
  getCodexConfigSnippet,
  removeCodexConfig,
  writeModelToCodexConfig,
} from "./local-config";
import { fetchAvailableCodexModels } from "./models";
import {
  CODEX_VERIFY_MARKER_COMMAND,
  buildRemoveCodexConfigScript,
  buildUpdateCodexModelScript,
  buildWriteCodexConfigScript,
} from "./remote-config";
import { registerCodexModelsRoute } from "./routes/models";
import { registerResponsesRoute } from "./routes/responses";
import { CopilotResponsesClient } from "./responses-client";

export const codexPlugin: AgentPlugin = {
  id: "codex",
  displayName: "Codex CLI",
  /**
   * Codex routes mount under `/codex/v1/...` so they never collide with
   * Claude's Anthropic-native `/v1/...` routes. The prefix is implicit in
   * the per-route paths (Hono doesn't support a `basePath` on a `Hono`
   * instance after construction); we still record it on the plugin for
   * documentation / future routing introspection.
   */
  routePrefix: "/codex",
  modelHint: "Codex CLI will use this model",

  registerRoutes(app: Hono, getClient: () => CopilotClient | null): void {
    registerResponsesRoute(app, () => {
      const client = getClient();
      if (!client) return null;
      return new CopilotResponsesClient(client.getTokenManager());
    });
    registerCodexModelsRoute(app, () => {
      const client = getClient();
      if (!client) return null;
      return client.getTokenManager();
    });
  },

  async fetchModels(tokenManager: TokenManager): Promise<AgentModelInfo[]> {
    return fetchAvailableCodexModels(tokenManager);
  },

  localConfig: {
    apply: applyCodexConfig,
    remove: removeCodexConfig,
    writeModel: writeModelToCodexConfig,
    getSnippet: getCodexConfigSnippet,
  },

  remoteConfig: {
    /**
     * Codex is additive: a Codex remote-config write failure must NOT
     * tear down a working Claude connection. The codespace manager honours
     * this flag — the tunnel stays up and a warning is logged.
     */
    criticalForTunnel: false,
    buildWriteScript: buildWriteCodexConfigScript,
    buildVerifyMarkerCommand: () => CODEX_VERIFY_MARKER_COMMAND,
    buildUpdateModelScript: buildUpdateCodexModelScript,
    buildRemoveScript: buildRemoveCodexConfigScript,
  },
};
