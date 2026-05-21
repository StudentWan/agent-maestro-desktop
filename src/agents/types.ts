/**
 * Per-agent plugin contract.
 *
 * Everything that is *specific to one coding-agent CLI* (Claude Code,
 * Codex, ...) lives behind one of these objects. Shared infrastructure
 * (the proxy server, the codespace SSH manager, the IPC layer, the
 * renderer) only consumes plugins through this interface — it never
 * imports agent modules by name. That way the boundary between Claude
 * code and Codex code is mechanically enforced: anywhere you'd want to
 * write `if (agent === "claude")`, you instead extend the plugin
 * contract.
 *
 * The plugin id is the single source of truth used in:
 *   - HTTP route prefixes (claude → "/", codex → "/codex")
 *   - IPC channel payloads (`{ agentId, modelId }`)
 *   - electron-store keys (`selectedModels[id]`)
 *   - renderer panel registry
 */
import type { Hono } from "hono";
import type { CopilotClient } from "../copilot/client";
import type { TokenManager } from "../copilot/token-manager";

export type AgentId = "claude" | "codex";

export interface AgentModelInfo {
  id: string;
  name: string;
}

/**
 * What the renderer needs to know up-front about an agent in order to
 * render the right panel without having to hit IPC for every detail.
 * Keep small — heavyweight info (models list, selected model, env vars)
 * is fetched separately so the panel can re-render reactively.
 */
export interface AgentDescriptor {
  id: AgentId;
  displayName: string;
  /**
   * "Claude Code" → "claude", "Codex CLI" → "codex". Lowercase, used in
   * URLs and store keys.
   */
  slug: string;
  /** True if this agent has a config file to display (e.g. Codex TOML). */
  hasFileSnippet: boolean;
  /** Short copy shown under the model selector. */
  modelHint: string;
}

/**
 * One agent's local-machine config snippet for the AgentConfigPanel UI.
 * Either env vars (Claude) or a config file (Codex), or both.
 */
export interface AgentLocalConfigSnippet {
  /** Display label for the env block (omitted if empty). */
  envLabel?: string;
  envVars: Record<string, string>;
  /** Optional file snippet (Codex's `~/.codex/config.toml`). */
  file?: {
    path: string;
    content: string;
    language: "json" | "toml";
  };
}

/**
 * The "what gets shown in the AgentConfigPanel" payload — built per-agent
 * by the plugin's localConfig.getSnippet(port, modelId).
 */
export interface AgentAppConfig {
  agentId: AgentId;
  proxyPort: number;
  /** "http://127.0.0.1:23337" or "http://127.0.0.1:23337/codex/v1". */
  baseUrl: string;
  snippet: AgentLocalConfigSnippet;
}

export interface AgentLocalConfig {
  /** Write our managed values to the local config (env file or TOML). */
  apply(port: number): Promise<void>;
  /** Strip ONLY the values we wrote — never touch user-authored content. */
  remove(port: number): Promise<void>;
  /** Update the selected model in the local config. */
  writeModel(modelId: string): Promise<void>;
  /** Build the snippet shown in the renderer's AgentConfigPanel. */
  getSnippet(port: number, modelId: string | null): AgentLocalConfigSnippet;
}

/**
 * Codespace remote-config script generators.
 *
 * Each plugin provides Python3 / shell scripts that the codespace manager
 * runs over SSH on the remote codespace. Scripts are agent-specific:
 *   - Claude writes ~/.claude/settings.json and ~/.claude.json
 *   - Codex writes ~/.codex/config.toml
 *
 * Atomicity (tmp-file + os.replace) is the responsibility of each plugin's
 * scripts — the shared `_atomic_dump` Python helper lives at
 * `src/codespace/atomic-dump.ts`.
 *
 * `criticalForTunnel` controls failure semantics in
 * CodespaceManager.writeRemoteConfigWithRetry:
 *   - true  → if THIS plugin's write fails, the tunnel is torn down with
 *             a "remote-config-failed" error (today's Claude behaviour).
 *   - false → failure is logged but the tunnel stays up (Codex is
 *             additive; a TOML-write hiccup must not regress Claude UX).
 */
export interface AgentRemoteConfig {
  /** Whether a write failure should tear down the tunnel. */
  criticalForTunnel: boolean;
  /** Build a Python3 -c script that atomically writes the agent's config. */
  buildWriteScript(port: number, modelId: string): string;
  /**
   * Build a Python3 -c script that re-runs the "post-write checklist"
   * (e.g. Claude's ~/.claude.json onboarding marker). Optional — return
   * null if there's nothing extra to do. Runs after buildWriteScript and
   * BEFORE buildVerifyMarkerCommand.
   */
  buildPostWriteScript?(): string | null;
  /**
   * Shell command that prints a positive integer to stdout when the
   * managed marker is present in the remote config. The manager grep-style
   * verifies this after every write attempt.
   */
  buildVerifyMarkerCommand(): string;
  /** Update only the model field, preserving everything else. */
  buildUpdateModelScript(modelId: string): string;
  /** Strip our managed block; preserve user-authored content. */
  buildRemoveScript(): string;
}

export interface AgentPlugin {
  /** Stable identifier — used in URLs, store, IPC, renderer. */
  readonly id: AgentId;
  /** Human-readable name shown in the UI ("Claude Code", "Codex CLI"). */
  readonly displayName: string;
  /** URL prefix for this agent's routes. "" for Claude, "/codex" for Codex. */
  readonly routePrefix: string;
  /** Short hint shown under the model picker in the renderer. */
  readonly modelHint: string;

  /**
   * Register this agent's HTTP routes on the shared Hono app. Called once
   * at proxy boot. The closure passed in resolves the current
   * CopilotClient (may be null until the user logs in — handlers should
   * 401 in that case).
   */
  registerRoutes(app: Hono, getClient: () => CopilotClient | null): void;

  /** Fetch the model list this agent supports (filtered Copilot models). */
  fetchModels(tokenManager: TokenManager): Promise<AgentModelInfo[]>;

  /** Local config writer (env vars or config file). */
  readonly localConfig: AgentLocalConfig;

  /** Codespace remote config scripts. */
  readonly remoteConfig: AgentRemoteConfig;
}

/** Build a renderer-facing descriptor from a plugin. */
export function describeAgent(plugin: AgentPlugin): AgentDescriptor {
  return {
    id: plugin.id,
    displayName: plugin.displayName,
    slug: plugin.id,
    hasFileSnippet:
      plugin.localConfig.getSnippet(0, null).file !== undefined,
    modelHint: plugin.modelHint,
  };
}
