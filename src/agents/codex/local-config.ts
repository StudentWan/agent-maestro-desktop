import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse, stringify } from "smol-toml";
import type { AgentLocalConfigSnippet } from "../types";

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

const PROVIDER_NAME = "agent-maestro";
const PROVIDER_DISPLAY = "Agent Maestro Desktop";

interface CodexConfig {
  model?: string;
  model_provider?: string;
  model_providers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
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
  await writeFileAtomic(CONFIG_PATH, stringify(merged));
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
    await writeFileAtomic(CONFIG_PATH, stringify(next));
  }
  console.log("[CodexConfig] Removed agent-maestro provider entries");
}

/**
 * Set the `model` field. Keeps the provider config in place (re-derives
 * the port from the existing provider entry if present). If no provider
 * exists yet, we still write the model — the next `applyCodexConfig`
 * call will fill in the provider.
 */
export async function writeModelToCodexConfig(modelId: string): Promise<void> {
  const raw = await readFileOrEmpty(CONFIG_PATH);
  const existing = parseExisting(raw);
  existing.model = modelId;
  await writeFileAtomic(CONFIG_PATH, stringify(existing));
  console.log(`[CodexConfig] Model set to: ${modelId}`);
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
): AgentLocalConfigSnippet {
  const snippet = mergeProvider({}, port, modelId);
  return {
    envVars: {},
    file: {
      path: "~/.codex/config.toml",
      content: stringify(snippet),
      language: "toml",
    },
  };
}

/** Test-only helpers. Not part of the AgentPlugin contract. */
export const __testing = {
  parseExisting,
  mergeProvider,
  stripProvider,
  PROVIDER_NAME,
  CONFIG_PATH,
};
