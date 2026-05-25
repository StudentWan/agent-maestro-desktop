/**
 * Generates Python3 shell scripts that run inside GitHub Codespaces
 * to configure Codex CLI's `~/.codex/config.toml`.
 *
 * Same atomic-write contract as the Claude remote-config: serialize to a
 * sibling tmp file, fsync, os.replace onto the target. The shared helper
 * `_atomic_dump_text` (text-only) lives in `src/codespace/atomic-dump.ts`.
 *
 * Why marker-comment splicing instead of "write our own TOML parser
 * inside Python":
 *   - Codex users frequently put `[mcp_servers.*]`, custom profiles,
 *     etc. in this file. We must NEVER clobber any of that.
 *   - Python ≤3.10 ships without `tomllib`; we'd need to bundle / install
 *     a parser. Marker splicing needs nothing beyond stdlib + grep.
 *   - The same marker-comment block is used by the LOCAL writer
 *     (`src/agents/codex/local-config.ts`), so behaviour is symmetric
 *     between local config and codespace config.
 *
 * The scripts assume Python3 is available in the codespace image — true
 * for every official `mcr.microsoft.com/devcontainers/...` base. The
 * remote-config retry loop in `CodespaceManager.writePluginRemoteConfigWithRetry`
 * catches failures cleanly if it isn't.
 */
import { ATOMIC_DUMP_HELPER } from "../../codespace/atomic-dump";

const MARKER_BEGIN = "# >>> agent-maestro-managed >>>";
const MARKER_END = "# <<< agent-maestro-managed <<<";
const PROVIDER_NAME = "agent-maestro";

/**
 * Shell command that prints a positive integer to stdout when the Codex
 * managed marker is present. The codespace manager runs this after each
 * write attempt and retries until it returns ≥1 (or attempts exhausted).
 */
export const CODEX_VERIFY_MARKER_COMMAND =
  "cat ~/.codex/config.toml 2>/dev/null | grep -c agent-maestro-managed || true";

/** Escape a value for embedding in a Python single-quoted string. */
function escapePython(value: string): string {
  return value.replace(/\\/g, "").replace(/'/g, "");
}

/** Escape a value for the TOML string we emit FROM Python. */
function escapeTomlForPython(value: string): string {
  // First strip Python-dangerous chars, then escape for TOML.
  return escapePython(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the body that goes BETWEEN the marker comments. Mirrors the
 * local-config renderer exactly so users see the same content whether they
 * inspect the file locally or in a codespace.
 */
function buildManagedBlockBody(port: number | null, model: string | null): string {
  const lines: string[] = [];
  lines.push("# Managed by Agent Maestro Desktop. Do not edit manually --");
  lines.push("# changes inside this block will be overwritten. Anything OUTSIDE");
  lines.push("# the markers is preserved verbatim.");
  lines.push(`model_provider = "${PROVIDER_NAME}"`);
  if (model) {
    lines.push(`model = "${escapeTomlForPython(model)}"`);
  }
  lines.push("");
  lines.push(`[model_providers.${PROVIDER_NAME}]`);
  lines.push(`name = "Agent Maestro Desktop"`);
  if (port !== null) {
    lines.push(`base_url = "http://127.0.0.1:${port}/codex/v1"`);
  }
  lines.push(`wire_api = "responses"`);
  lines.push(`request_timeout = 600`);
  lines.push(`__agent_maestro_managed = true`);
  return lines.join("\n");
}

/**
 * Inline a Python helper that performs the marker-block splice. Defined
 * once per script (cheap; the script string is throwaway). Mirrors the
 * TypeScript splicer in `local-config.ts` so behaviour matches between
 * local writes and remote writes.
 *
 * The managed block is ALWAYS written at the TOP of the file. Codex's
 * `model_provider` / `model` are TOML root-level keys; if they appear
 * after any `[table]` header (e.g. user's `[mcp_servers.*]`) they get
 * silently absorbed into that table. On every call we strip any existing
 * block (wherever it is) and re-insert at the top — which also auto-
 * migrates files written by older versions that appended at the bottom.
 */
const SPLICE_HELPER = `
def _strip_block(existing):
    begin = '${MARKER_BEGIN}'
    end = '${MARKER_END}'
    bi = existing.find(begin)
    ei = existing.find(end)
    if bi == -1 or ei == -1 or ei <= bi:
        return existing
    line_end = existing.find('\\n', ei)
    if line_end == -1:
        line_end = len(existing)
    else:
        line_end += 1
    before = existing[:bi]
    after = existing[line_end:]
    # Collapse trailing newlines on 'before' to at most one so removing a
    # mid-file block doesn't leave a doubled blank line behind.
    if before:
        i = len(before)
        while i > 0 and before[i - 1] == '\\n':
            i -= 1
        before = before[:i] + '\\n'
    return before + after

def _splice_block(existing, body):
    begin = '${MARKER_BEGIN}'
    end = '${MARKER_END}'
    stripped = _strip_block(existing)
    if body is None:
        return '' if not stripped.strip() else stripped
    block = begin + '\\n' + body + '\\n' + end
    # Drop leading newlines from user content so we control spacing.
    remainder = stripped.lstrip('\\n')
    if not remainder:
        return block + '\\n'
    return block + '\\n\\n' + remainder
`;

/**
 * Build the Python3 -c invocation that splices our managed block into
 * `~/.codex/config.toml`, atomically. Used by `applyConfig` and
 * `writeModel`.
 */
function buildSpliceScript(blockBody: string | null): string {
  // The marker body is embedded as a Python triple-quoted string inside a
  // `python3 -c "..."` shell command. Two layers of escaping:
  //   1. Shell: `"` must become `\"` so it doesn't terminate the outer "...".
  //      Bash strips the backslash, so Python receives a bare `"` — correct.
  //   2. Python: guard against `'''` inside the body (shouldn't happen for
  //      our TOML, but cheap insurance).
  const shellSafe = blockBody?.replace(/"/g, '\\"') ?? null;
  const safeBody =
    shellSafe === null
      ? "None"
      : `'''${shellSafe.replace(/'''/g, "'\\''\\''\\'")}'''`;
  return `python3 -c "
import os
${ATOMIC_DUMP_HELPER}
${SPLICE_HELPER}
p = os.path.expanduser('~/.codex/config.toml')
try:
    existing = open(p).read()
except FileNotFoundError:
    existing = ''
body = ${safeBody}
out = _splice_block(existing, body)
if out == '':
    _atomic_dump_text('', p)
else:
    _atomic_dump_text(out, p)
"`;
}

/**
 * Build the script that writes (or re-writes) the managed block. If the
 * block already exists anywhere in the file, it is stripped first; the new
 * block is then inserted at the TOP of the file (with one blank line
 * separating it from user content). See SPLICE_HELPER for why top-only.
 */
export function buildWriteCodexConfigScript(
  port: number,
  model: string,
): string {
  const body = buildManagedBlockBody(port, model || null);
  return buildSpliceScript(body);
}

/**
 * Build the script that updates only the model field. We re-derive the
 * port from whatever's currently in the managed block (so a model-only
 * change doesn't drop the base_url). If no block exists, we simply write
 * a model-only block and let the next full apply re-add the port.
 */
export function buildUpdateCodexModelScript(model: string): string {
  const safeModel = escapePython(model);
  // Inline a tiny "extract port, then re-render" pre-step because the
  // splice helper is dumb on purpose (it never reads the existing block).
  return `python3 -c "
import os, re
${ATOMIC_DUMP_HELPER}
${SPLICE_HELPER}
p = os.path.expanduser('~/.codex/config.toml')
try:
    existing = open(p).read()
except FileNotFoundError:
    existing = ''
m = re.search(r'base_url\\s*=\\s*\\\"http://127\\.0\\.0\\.1:(\\d+)/codex/v1\\\"', existing)
port_line = ('base_url = \\\"http://127.0.0.1:%s/codex/v1\\\"' % m.group(1)) if m else ''
body_lines = [
    '# Managed by Agent Maestro Desktop. Do not edit manually --',
    '# changes inside this block will be overwritten. Anything OUTSIDE',
    '# the markers is preserved verbatim.',
    'model_provider = \\\"${PROVIDER_NAME}\\\"',
    'model = \\\"${safeModel}\\\"',
    '',
    '[model_providers.${PROVIDER_NAME}]',
    'name = \\\"Agent Maestro Desktop\\\"',
]
if port_line:
    body_lines.append(port_line)
body_lines.extend([
    'wire_api = \\\"responses\\\"',
    'request_timeout = 600',
    '__agent_maestro_managed = true',
])
body = '\\n'.join(body_lines)
out = _splice_block(existing, body)
_atomic_dump_text(out, p)
"`;
}

/**
 * Build the script that strips our managed block. Anything outside the
 * markers is left exactly as it was — that includes `[mcp_servers.*]`,
 * other `[model_providers.*]`, custom `[profiles.*]`, comments, etc.
 */
export function buildRemoveCodexConfigScript(): string {
  return buildSpliceScript(null);
}
