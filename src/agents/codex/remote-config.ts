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
  lines.push("# Managed by Agent Maestro Desktop. Do not edit manually —");
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
 */
const SPLICE_HELPER = `
def _splice_block(existing, body):
    begin = '${MARKER_BEGIN}'
    end = '${MARKER_END}'
    bi = existing.find(begin)
    ei = existing.find(end)
    if bi != -1 and ei != -1 and ei > bi:
        line_end = existing.find('\\n', ei)
        if line_end == -1:
            line_end = len(existing)
        else:
            line_end += 1
        before = existing[:bi]
        after = existing[line_end:]
        if body is None:
            trimmed = before[:-1] if before.endswith('\\n') else before
            joined = trimmed + after
            return '' if not joined.strip() else joined
        sep = '' if (after == '' or after.startswith('\\n')) else '\\n'
        return before + begin + '\\n' + body + '\\n' + end + sep + after
    if body is None:
        return existing
    prefix = existing
    if prefix and not prefix.endswith('\\n'):
        prefix += '\\n'
    if prefix and not prefix.endswith('\\n\\n'):
        prefix += '\\n'
    return prefix + begin + '\\n' + body + '\\n' + end + '\\n'
`;

/**
 * Build the Python3 -c invocation that splices our managed block into
 * `~/.codex/config.toml`, atomically. Used by `applyConfig` and
 * `writeModel`.
 */
function buildSpliceScript(blockBody: string | null): string {
  // The marker body is embedded as a Python triple-quoted string. We
  // doubly-escape any embedded triple-quote possibility just in case
  // (shouldn't happen for our TOML, but cheap insurance).
  const safeBody =
    blockBody === null
      ? "None"
      : `'''${blockBody.replace(/'''/g, "'\\''\\''\\'")}'''`;
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
 * block already exists, it is preserved-then-replaced; if not, it is
 * appended after a blank line.
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
    '# Managed by Agent Maestro Desktop. Do not edit manually —',
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
