import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentLocalConfigSnippet } from "../types";

/**
 * Local writer for `~/.codex/config.toml`.
 *
 * Codex CLI doesn't support env vars for "where do I send my API calls"
 * the way Claude does — it reads `model_providers.<name>.base_url` and
 * `wire_api` from a TOML config file. So we manage that file in-place.
 *
 * Boundary contract: we MUST NOT clobber user-authored TOML. The user is
 * very likely to have `[mcp_servers.*]`, `[model_providers.openai]`, custom
 * `[profiles.*]`, etc. in this file already. We isolate every key we own
 * inside a marker-comment block, ALWAYS placed at the TOP of the file:
 *
 *   # >>> agent-maestro-managed >>>
 *   # ...lines we own (root-level keys + our [model_providers.*] table)...
 *   # <<< agent-maestro-managed <<<
 *
 *   <existing user content (their tables, comments, etc.)>
 *
 * Position matters: TOML root-level keys like `model_provider = "..."` MUST
 * appear before any `[table]` header, otherwise they're parsed as a field of
 * the most recent table. Our block contains root keys (`model_provider`,
 * `model`) followed by a `[model_providers.agent-maestro]` table, so if the
 * user has e.g. `[mcp_servers.*]` first, an appended block would have its
 * root keys silently absorbed into `[mcp_servers.*]`. We always prepend.
 *
 * Every read parses ONLY the marker block; every write strips the existing
 * block (wherever it is) and re-inserts it at the top. That sidesteps the
 * need for a real TOML round-tripping library (the only realistic Node.js
 * option, `smol-toml`, doesn't preserve comments / formatting), and also
 * auto-migrates files that were previously written with the block at the
 * bottom.
 *
 * What goes inside the marker block:
 *   model_provider = "agent-maestro"
 *   model = "<modelId>"            (only when a model is selected)
 *
 *   [model_providers.agent-maestro]
 *   name = "Agent Maestro Desktop"
 *   base_url = "http://127.0.0.1:<port>/codex/v1"
 *   wire_api = "responses"
 *   request_timeout = 600
 *   __agent_maestro_managed = true
 *
 * The `__agent_maestro_managed` field doubles as an at-a-glance marker for
 * humans reading the file and as the grep target for the Codespace remote
 * verifier (`agent-maestro-managed`).
 */

const CODEX_DIR = path.join(os.homedir(), ".codex");
const CONFIG_PATH = path.join(CODEX_DIR, "config.toml");

const MARKER_BEGIN = "# >>> agent-maestro-managed >>>";
const MARKER_END = "# <<< agent-maestro-managed <<<";

const PROVIDER_NAME = "agent-maestro";

interface ManagedBlockState {
  port: number | null;
  modelId: string | null;
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
 * Render the body of the managed block (everything between MARKER_BEGIN and
 * MARKER_END, exclusive). Stable ordering keeps file diffs minimal.
 */
function renderManagedBlock(state: ManagedBlockState): string {
  const lines: string[] = [];
  lines.push(`# Managed by Agent Maestro Desktop. Do not edit manually —`);
  lines.push(`# changes inside this block will be overwritten. Anything OUTSIDE`);
  lines.push(`# the markers is preserved verbatim.`);
  lines.push(`model_provider = "${PROVIDER_NAME}"`);
  if (state.modelId) {
    lines.push(`model = "${escapeTomlString(state.modelId)}"`);
  }
  lines.push("");
  lines.push(`[model_providers.${PROVIDER_NAME}]`);
  lines.push(`name = "Agent Maestro Desktop"`);
  if (state.port !== null) {
    lines.push(`base_url = "http://127.0.0.1:${state.port}/codex/v1"`);
  }
  lines.push(`wire_api = "responses"`);
  lines.push(`request_timeout = 600`);
  lines.push(`__agent_maestro_managed = true`);
  return lines.join("\n");
}

/**
 * Splice (insert / replace / remove) the marker block in `existing`. The
 * managed block is ALWAYS placed at the top of the file (see file header
 * for why). On every call we strip any existing block (wherever it is) and
 * either drop it (when `replacement` is null) or re-insert at the top —
 * which also auto-migrates files written by older versions that appended.
 */
function spliceManagedBlock(
  existing: string,
  replacement: string | null,
): string {
  const stripped = stripManagedBlock(existing);

  if (replacement === null) {
    return stripped.trim().length === 0 ? "" : stripped;
  }

  const block = MARKER_BEGIN + "\n" + replacement + "\n" + MARKER_END;
  // Drop any leading newlines from the user content so we control spacing.
  const remainder = stripped.replace(/^\n+/, "");

  if (remainder.length === 0) {
    return block + "\n";
  }
  // One blank line between our block and user content.
  return block + "\n\n" + remainder;
}

/**
 * Remove the marker block (if present) and return the rest of the file.
 * Collapses any blank-line buildup at the seam so repeated apply/remove
 * cycles don't accumulate whitespace.
 */
function stripManagedBlock(existing: string): string {
  const beginIdx = existing.indexOf(MARKER_BEGIN);
  const endIdx = existing.indexOf(MARKER_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return existing;
  }
  let endLineEnd = existing.indexOf("\n", endIdx);
  if (endLineEnd === -1) endLineEnd = existing.length;
  else endLineEnd += 1; // include the newline

  const before = existing.slice(0, beginIdx);
  const after = existing.slice(endLineEnd);

  // Collapse trailing newlines on `before` to at most one, so removing a
  // mid-file block doesn't leave a doubled blank line behind.
  const trimmedBefore =
    before.length > 0 ? before.replace(/\n+$/, "\n") : before;
  return trimmedBefore + after;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Read the model id currently inside the managed block (if any). Used so
 * `applyCodexConfig` and `writeModelToCodexConfig` can preserve any model
 * that was previously set when re-applying after a port change.
 */
function extractModelFromBlock(existing: string): string | null {
  const beginIdx = existing.indexOf(MARKER_BEGIN);
  const endIdx = existing.indexOf(MARKER_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return null;
  const block = existing.slice(beginIdx, endIdx);
  // model = "..." (only inside our block — outside is user content)
  const match = /^\s*model\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(block);
  if (!match) return null;
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/**
 * Write our managed block to `~/.codex/config.toml`. Preserves any
 * previously-set model id (so a port-change re-apply doesn't blank the
 * model).
 */
export async function applyCodexConfig(port: number): Promise<void> {
  const existing = await readFileOrEmpty(CONFIG_PATH);
  const previousModel = extractModelFromBlock(existing);
  const block = renderManagedBlock({ port, modelId: previousModel });
  const next = spliceManagedBlock(existing, block);
  await writeFileAtomic(CONFIG_PATH, next);
  console.log(
    `[CodexConfig] Applied — base_url=http://127.0.0.1:${port}/codex/v1`,
  );
}

/**
 * Strip the managed block. User-authored content is preserved byte-for-byte.
 */
export async function removeCodexConfig(_port: number): Promise<void> {
  const existing = await readFileOrEmpty(CONFIG_PATH);
  if (!existing) return;
  const next = spliceManagedBlock(existing, null);
  if (next.length === 0) {
    // The file ended up empty after stripping our block — leave the file
    // in place (rather than deleting) so the user's stat/inotify watchers
    // don't fire spuriously, but write the empty content for atomicity.
    await writeFileAtomic(CONFIG_PATH, "");
  } else {
    await writeFileAtomic(CONFIG_PATH, next);
  }
  console.log("[CodexConfig] Removed managed block");
}

/**
 * Update only the `model = "..."` line inside the managed block. If the
 * block isn't present (e.g. the user removed it manually), we re-create it
 * with no port — `applyCodexConfig` is the right place to set the port.
 *
 * The port we use here comes from re-reading the existing block (so we
 * don't accidentally drop the base_url).
 */
export async function writeModelToCodexConfig(modelId: string): Promise<void> {
  const existing = await readFileOrEmpty(CONFIG_PATH);
  const port = extractPortFromBlock(existing);
  const block = renderManagedBlock({ port, modelId });
  const next = spliceManagedBlock(existing, block);
  await writeFileAtomic(CONFIG_PATH, next);
  console.log(`[CodexConfig] Model set to: ${modelId}`);
}

function extractPortFromBlock(existing: string): number | null {
  const beginIdx = existing.indexOf(MARKER_BEGIN);
  const endIdx = existing.indexOf(MARKER_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return null;
  const block = existing.slice(beginIdx, endIdx);
  // base_url = "http://127.0.0.1:<port>/codex/v1"
  const match = /base_url\s*=\s*"http:\/\/127\.0\.0\.1:(\d+)/.exec(block);
  if (!match) return null;
  const port = parseInt(match[1], 10);
  return Number.isFinite(port) ? port : null;
}

/**
 * Snippet shown in the renderer's AgentConfigPanel for Codex.
 *
 * Codex has no env-var configuration to surface, but it DOES have a TOML
 * file we manage — show the rendered managed block so users curious about
 * what we're putting in their config can see it at a glance and copy-paste
 * it elsewhere if they want.
 */
export function getCodexConfigSnippet(
  port: number,
  modelId: string | null,
): AgentLocalConfigSnippet {
  const block = renderManagedBlock({ port, modelId });
  return {
    envVars: {},
    file: {
      path: "~/.codex/config.toml",
      content: MARKER_BEGIN + "\n" + block + "\n" + MARKER_END,
      language: "toml",
    },
  };
}

/** Test-only helpers. Not part of the AgentPlugin contract. */
export const __testing = {
  spliceManagedBlock,
  stripManagedBlock,
  renderManagedBlock,
  extractModelFromBlock,
  extractPortFromBlock,
  MARKER_BEGIN,
  MARKER_END,
  CONFIG_PATH,
};
