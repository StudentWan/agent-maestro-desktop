import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse, stringify } from "smol-toml";
import type { AgentLocalConfigSnippet, AgentModelInfo, AgentWriteModelOptions } from "../types";

/**
 * Local writer for `~/.codex/config.toml`.
 *
 * Codex CLI doesn't support env vars for "where do I send my API calls"
 * the way Claude does — it reads `model_providers.<name>.base_url` and
 * `wire_api` from a TOML config file. So we manage that file in-place.
 *
 * Approach (matches upstream Joouis/agent-maestro):
 *   1. Read the existing file (empty string if missing).
 *   2. Parse it with `smol-toml` into a JS object.
 *   3. Merge our keys (`model`, `model_provider`,
 *      `model_providers["agent-maestro"]`) on top of the parsed object.
 *   4. `stringify` the merged object and atomically write it back.
 *
 * Trade-off vs. marker-comment splicing: this DOES NOT preserve user
 * comments or formatting (smol-toml is not a round-tripping parser).
 * In return, we get a structurally correct TOML output where root-level
 * keys (`model_provider`, `model`) are guaranteed to appear before any
 * `[table]` header — otherwise TOML parses them as fields of the most
 * recent table and Codex silently ignores them. The marker approach got
 * this wrong by inserting our block after user-authored tables.
 *
 * Fields we own (and clean up on remove):
 *   model_provider = "agent-maestro"
 *   [model_providers.agent-maestro]
 *     name, base_url, wire_api, request_timeout
 *
 * `model` is treated as user-owned in remove (we don't know whether it
 * was set by us or by the user) but is overwritten by `writeModel`.
 */

const CODEX_DIR = path.join(os.homedir(), ".codex");
const CONFIG_PATH = path.join(CODEX_DIR, "config.toml");
const MODEL_CATALOG_PATH = path.join(CODEX_DIR, "agent-maestro-models.json");

const PROVIDER_NAME = "agent-maestro";
const PROVIDER_DISPLAY = "Agent Maestro Desktop";

interface CodexConfig {
  model?: string;
  model_provider?: string;
  model_context_window?: number;
  model_catalog_json?: string;
  model_providers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

function isTomlTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function putManagedProviderFirst(
  modelProviders: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  if (!(PROVIDER_NAME in modelProviders)) {
    return modelProviders;
  }

  const { [PROVIDER_NAME]: managedProvider, ...otherProviders } =
    modelProviders;
  return {
    [PROVIDER_NAME]: managedProvider,
    ...otherProviders,
  };
}

/**
 * Canonicalize the table order before stringifying. Standard TOML parsers do
 * not care where a table appears, but some Codex app/CLI combinations have
 * behaved order-sensitively when a user config has many tables. Keep the
 * provider block near the root keys, matching the layout users found reliable.
 */
function orderForStringify(config: CodexConfig): CodexConfig {
  const ordered: CodexConfig = {};

  for (const [key, value] of Object.entries(config)) {
    if (key !== "model_providers" && !isTomlTable(value)) {
      ordered[key] = value;
    }
  }

  if (config.model_providers) {
    ordered.model_providers = putManagedProviderFirst(config.model_providers);
  }

  for (const [key, value] of Object.entries(config)) {
    if (key !== "model_providers" && isTomlTable(value)) {
      ordered[key] = value;
    }
  }

  return ordered;
}

function stringifyCodexConfig(config: CodexConfig): string {
  return stringify(orderForStringify(config));
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Parse the existing config.toml safely. A parse error means the user has
 * a broken file already — in that case we start from an empty object so
 * the next write produces something valid (and the user's broken content
 * is overwritten, which is the same behaviour as upstream).
 */
function parseExisting(raw: string): CodexConfig {
  if (!raw.trim()) return {};
  try {
    return parse(raw) as CodexConfig;
  } catch (error) {
    console.warn(
      `[CodexConfig] Existing config.toml failed to parse — starting fresh: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}

/**
 * Apply our provider on top of an existing parsed config. Other
 * `[model_providers.*]` entries (e.g. `openai`, user-defined) are
 * preserved.
 */
function mergeProvider(
  existing: CodexConfig,
  port: number,
  modelId: string | null,
  contextWindow?: number,
): CodexConfig {
  const merged: CodexConfig = {
    ...existing,
    model_provider: PROVIDER_NAME,
    model_providers: {
      ...(existing.model_providers ?? {}),
      [PROVIDER_NAME]: {
        name: PROVIDER_DISPLAY,
        base_url: `http://127.0.0.1:${port}/codex/v1`,
        wire_api: "responses",
        request_timeout: 600,
      },
    },
  };
  if (modelId) {
    merged.model = modelId;
  }
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    merged.model_context_window = contextWindow;
  }
  return merged;
}

/**
 * Strip our provider out of an existing parsed config. Returns null if
 * the resulting object is empty (so the caller can decide whether to
 * truncate the file or leave it alone).
 */
function stripProvider(existing: CodexConfig): CodexConfig | null {
  const next: CodexConfig = { ...existing };
  if (next.model_provider === PROVIDER_NAME) {
    delete next.model_provider;
  }
  if (next.model_catalog_json === MODEL_CATALOG_PATH) {
    delete next.model_catalog_json;
  }
  if (next.model_providers && PROVIDER_NAME in next.model_providers) {
    const { [PROVIDER_NAME]: _ours, ...rest } = next.model_providers;
    if (Object.keys(rest).length === 0) {
      delete next.model_providers;
    } else {
      next.model_providers = rest;
    }
  }
  return Object.keys(next).length === 0 ? null : next;
}

/**
 * Write the merged config. `applyCodexConfig` preserves any `model` the
 * user (or a previous `writeModel` call) had set — we don't blow it away
 * just because the port changed.
 */
export async function applyCodexConfig(port: number): Promise<void> {
  const raw = await readFileOrEmpty(CONFIG_PATH);
  const existing = parseExisting(raw);
  const merged = mergeProvider(existing, port, null);
  await writeFileAtomic(CONFIG_PATH, stringifyCodexConfig(merged));
  console.log(
    `[CodexConfig] Applied — base_url=http://127.0.0.1:${port}/codex/v1`,
  );
}

/**
 * Strip our provider keys; preserve everything else the user had.
 */
export async function removeCodexConfig(_port: number): Promise<void> {
  const raw = await readFileOrEmpty(CONFIG_PATH);
  if (!raw) return;
  const existing = parseExisting(raw);
  const next = stripProvider(existing);
  if (next === null) {
    await writeFileAtomic(CONFIG_PATH, "");
  } else {
    await writeFileAtomic(CONFIG_PATH, stringifyCodexConfig(next));
  }
  console.log("[CodexConfig] Removed agent-maestro provider entries");
}

/**
 * Set the `model` field. Keeps the provider config in place (re-derives
 * the port from the existing provider entry if present). If no provider
 * exists yet, we still write the model — the next `applyCodexConfig`
 * call will fill in the provider.
 *
 * When `options.contextWindow` is provided, also writes
 * `model_context_window = <N>` so Codex auto-compacts before bodies hit
 * Copilot's 413 ceiling. The field is left untouched (not deleted) when
 * the option is omitted — that way switching to a model whose context
 * window hasn't been fetched yet won't clobber a previously-correct value.
 */
export async function writeModelToCodexConfig(
  modelId: string,
  options?: AgentWriteModelOptions,
): Promise<void> {
  const raw = await readFileOrEmpty(CONFIG_PATH);
  const existing = parseExisting(raw);
  existing.model = modelId;
  const ctx = options?.contextWindow;
  if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) {
    existing.model_context_window = ctx;
  }
  await writeFileAtomic(CONFIG_PATH, stringifyCodexConfig(existing));
  console.log(
    `[CodexConfig] Model set to: ${modelId}${
      typeof ctx === "number" ? `, model_context_window=${ctx}` : ""
    }`,
  );
}

const DEFAULT_REASONING_DESCRIPTIONS: Record<string, string> = {
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Maximizes reasoning depth for complex problems",
  xhigh: "Extra high reasoning effort for complex problems",
};

interface CodexCatalogModelEntry {
  slug: string;
  display_name: string;
  description?: string;
  visibility: string;
  supported_in_api: boolean;
  priority: number;
  shell_type: string;
  base_instructions: string;
  supports_reasoning_summaries: boolean;
  support_verbosity: boolean;
  truncation_policy: { mode: "bytes" | "tokens"; limit: number };
  supports_parallel_tool_calls: boolean;
  experimental_supported_tools: string[];
  supports_search_tool?: boolean;
  context_window?: number;
  max_context_window?: number;
  default_reasoning_level?: string;
  supported_reasoning_levels: Array<{ effort: string; description: string }>;
  [key: string]: unknown;
}

// Custom catalogs and files written by older Agent Maestro versions may be
// incomplete. Only the generated output must satisfy the full Codex contract.
type CodexCatalogSeedEntry = Pick<CodexCatalogModelEntry, "slug"> & Partial<CodexCatalogModelEntry>;

async function readCatalogSeed(filePath: string): Promise<Map<string, CodexCatalogSeedEntry>> {
  const seed = new Map<string, CodexCatalogSeedEntry>();
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { models?: unknown };
    if (Array.isArray(parsed.models)) {
      for (const entry of parsed.models) {
        if (entry && typeof entry === "object" && typeof (entry as { slug?: unknown }).slug === "string") {
          const typed = entry as CodexCatalogSeedEntry;
          seed.set(typed.slug.toLowerCase(), typed);
        }
      }
    }
  } catch {
    // Missing or unreadable seed file is fine
  }
  return seed;
}

function buildCodexCatalogEntry(
  model: AgentModelInfo,
  priority: number,
  seed: CodexCatalogSeedEntry | undefined,
  fallbackTemplate: CodexCatalogSeedEntry | undefined,
): CodexCatalogModelEntry {
  const contextWindow = model.contextWindow ?? seed?.context_window ?? 128000;
  const reasoningEfforts = model.reasoningEfforts?.filter(
    (e) => e === "low" || e === "medium" || e === "high" || e === "xhigh",
  );
  const supportedReasoningLevels =
    reasoningEfforts && reasoningEfforts.length > 0
      ? reasoningEfforts.map((effort) => ({
          effort,
          description: DEFAULT_REASONING_DESCRIPTIONS[effort] ?? `${effort} reasoning effort`,
        }))
      : seed?.supported_reasoning_levels ??
        fallbackTemplate?.supported_reasoning_levels ?? [
          { effort: "low", description: DEFAULT_REASONING_DESCRIPTIONS.low },
          { effort: "medium", description: DEFAULT_REASONING_DESCRIPTIONS.medium },
          { effort: "high", description: DEFAULT_REASONING_DESCRIPTIONS.high },
        ];

  const defaultReasoning =
    seed?.default_reasoning_level ??
    (supportedReasoningLevels.some((r) => r.effort === "high")
      ? "high"
      : supportedReasoningLevels[0]?.effort ?? "medium");

  // Apply defaults even when a seed exists: v1.4.0 catalogs omitted required
  // ModelInfo fields, so copying them as-is keeps Codex from loading config.
  const base = {
    prefer_websockets: false,
    support_verbosity: true,
    default_verbosity: "low",
    input_modalities: ["text", "image"],
    supports_parallel_tool_calls: true,
    shell_type: "shell_command",
    minimal_client_version: "0.124.0",
    base_instructions: "You are a coding assistant. Help the user with software development tasks.",
    supports_reasoning_summaries: false,
    truncation_policy: { mode: "tokens" as const, limit: 10000 },
    experimental_supported_tools: [],
    ...(seed ?? fallbackTemplate),
  };

  const isOpenAINative =
    model.id.toLowerCase().startsWith("gpt-") ||
    model.id.toLowerCase().startsWith("openai/") ||
    model.id.toLowerCase().startsWith("o1") ||
    model.id.toLowerCase().startsWith("o3") ||
    model.id.toLowerCase().startsWith("o4") ||
    model.id.toLowerCase().startsWith("o5") ||
    model.id.toLowerCase().includes("codex");

  return {
    ...base,
    slug: model.id,
    display_name: model.name || seed?.display_name || model.id,
    description: seed?.description || `${model.name || model.id} via GitHub Copilot`,
    visibility: "list",
    supported_in_api: true,
    priority,
    context_window: contextWindow,
    max_context_window: contextWindow,
    default_reasoning_level: defaultReasoning,
    supported_reasoning_levels: supportedReasoningLevels,
    supports_search_tool: isOpenAINative ? (base.supports_search_tool ?? true) : false,
  };
}

/**
 * Sync the discovered Copilot models into a Codex `model_catalog_json` file
 * (`~/.codex/agent-maestro-models.json`) and point `model_catalog_json` in
 * `~/.codex/config.toml` to it.
 *
 * Codex App reads its model picker list from `model_catalog_json` when
 * configured rather than polling `/codex/v1/models`, so keeping this file
 * synchronized ensures newly discovered models (Gemini, Grok, MAI-Code, etc.)
 * appear in Codex App automatically.
 */
export async function syncCodexModelCatalog(
  models: AgentModelInfo[],
  options?: { configPath?: string; catalogPath?: string },
): Promise<void> {
  if (models.length === 0) return;

  const configPath = options?.configPath ?? CONFIG_PATH;
  const catalogPath = options?.catalogPath ?? MODEL_CATALOG_PATH;

  const rawConfig = await readFileOrEmpty(configPath);
  const existingConfig = parseExisting(rawConfig);

  // Seed from any existing catalog (user's custom-models.json or our previous
  // catalog) so we preserve rich Codex metadata like base_instructions.
  const seed = new Map<string, CodexCatalogSeedEntry>();
  if (
    typeof existingConfig.model_catalog_json === "string" &&
    existingConfig.model_catalog_json !== catalogPath
  ) {
    for (const [k, v] of await readCatalogSeed(existingConfig.model_catalog_json)) {
      seed.set(k, v);
    }
  }
  for (const [k, v] of await readCatalogSeed(catalogPath)) {
    if (!seed.has(k)) {
      seed.set(k, v);
    }
  }

  const fallbackTemplate = Array.from(seed.values()).find((m) => m.visibility === "list") ??
    Array.from(seed.values())[0];

  const catalogModels = models.map((model, index) =>
    buildCodexCatalogEntry(
      model,
      index,
      seed.get(model.id.toLowerCase()),
      fallbackTemplate,
    ),
  );

  await writeFileAtomic(catalogPath, JSON.stringify({ models: catalogModels }, null, 2));

  if (existingConfig.model_catalog_json !== catalogPath) {
    existingConfig.model_catalog_json = catalogPath;
    await writeFileAtomic(configPath, stringifyCodexConfig(existingConfig));
  }

  console.log(
    `[CodexConfig] Synced ${catalogModels.length} model(s) to ${catalogPath}`,
  );
}

/**
 * Snippet shown in the renderer's AgentConfigPanel for Codex. We emit a
 * minimal valid TOML that contains only the keys we manage, so users
 * curious about what we're injecting can see the exact shape and copy
 * it into another machine if they want.
 */
export function getCodexConfigSnippet(
  port: number,
  modelId: string | null,
  options?: AgentWriteModelOptions,
): AgentLocalConfigSnippet {
  const snippet = mergeProvider({}, port, modelId, options?.contextWindow);
  return {
    envVars: {},
    file: {
      path: "~/.codex/config.toml",
      content: stringifyCodexConfig(snippet),
      language: "toml",
    },
  };
}

/** Test-only helpers. Not part of the AgentPlugin contract. */
export const __testing = {
  parseExisting,
  mergeProvider,
  stripProvider,
  stringifyCodexConfig,
  PROVIDER_NAME,
  CONFIG_PATH,
};
