/**
 * Generates Python3 shell scripts that run inside GitHub Codespaces
 * to configure Codex CLI's `~/.codex/config.toml`.
 *
 * Strategy mirrors the local writer in `src/agents/codex/local-config.ts`
 * (which uses `smol-toml` to do a parse → merge → stringify roundtrip):
 *
 *   1. Read the existing file (empty dict if missing).
 *   2. Parse it with `tomllib` (Python 3.11+; falls back to `tomli`).
 *   3. Merge our keys onto the parsed dict.
 *   4. Re-emit as TOML using a small inline serializer.
 *   5. Atomic-write via the shared `_atomic_dump_text` helper.
 *
 * We DO NOT preserve user comments or whitespace (tomllib doesn't expose
 * them; neither does smol-toml). This is the same trade-off the local
 * writer accepts. In exchange, root-level keys (`model_provider`,
 * `model`) are guaranteed to land above any `[table]` header instead of
 * being silently absorbed into the user's last table — which is exactly
 * the bug the previous marker-comment splice approach had.
 *
 * Python source is shipped to the codespace as a quoted-delimiter
 * here-doc (`python3 <<'PY_HEREDOC' ... PY_HEREDOC`). The quoted delimiter
 * disables shell interpolation, so the body passes through verbatim —
 * no `\\\\\\\\` escape stacks, no double-quote-shell-termination footguns
 * that would otherwise creep in once we have a TOML emitter with literal
 * `"` chars in it.
 *
 * Requires Python 3.11+ in the codespace image (true for every official
 * `mcr.microsoft.com/devcontainers/...` base in recent years). If not
 * available, the script fails and the codespace manager logs a warning;
 * the tunnel stays up because Codex's `criticalForTunnel` is false.
 */
import { ATOMIC_DUMP_HELPER } from "../../codespace/atomic-dump";

const PROVIDER_NAME = "agent-maestro";
const PROVIDER_DISPLAY = "Agent Maestro Desktop";

/**
 * Shell command that prints a positive integer to stdout when our
 * provider section is present. The codespace manager runs this after
 * each write attempt and retries until it returns ≥1 (or attempts
 * exhausted). Fixed-string grep so the brackets don't need escaping.
 */
export const CODEX_VERIFY_MARKER_COMMAND =
  "cat ~/.codex/config.toml 2>/dev/null | grep -cF '[model_providers.agent-maestro]' || true";

/**
 * Reject any user-supplied string (model id) that would break out of a
 * Python single-quoted literal or smuggle a newline into the here-doc.
 * The codespace manager calls these builders with model ids from our
 * own model list, but defence-in-depth: strip anything not in a safe
 * subset before embedding.
 */
function safeModelLiteral(value: string): string {
  // Conservative: letters, digits, dot, dash, underscore, slash, colon.
  return value.replace(/[^A-Za-z0-9._\-/:]/g, "");
}

/**
 * Inline a tiny Python TOML emitter. tomllib (3.11+) gives us parsing
 * but has no writer; we only need to emit dicts of:
 *   - scalars (strings, ints, floats, bools)
 *   - arrays of scalars
 *   - nested dicts (emitted as `[a.b.c]` section headers; inline tables
 *     are used for dicts that appear *inside* a value position).
 *
 * The emitter is good enough for any config a Codex user would realistically
 * have — `[mcp_servers.*]`, `[profiles.*]`, other `[model_providers.*]`
 * entries, root-level scalar options. It's not a general TOML writer.
 */
const TOML_EMITTER = `
def _toml_key(k):
    if k and all((c.isalnum() or c in '_-') for c in k):
        return k
    return '"' + k.replace('\\\\', '\\\\\\\\').replace('"', '\\\\"') + '"'

def _toml_value(v):
    if v is True: return 'true'
    if v is False: return 'false'
    if isinstance(v, int): return str(v)
    if isinstance(v, float): return repr(v)
    if isinstance(v, str):
        s = v.replace('\\\\', '\\\\\\\\').replace('"', '\\\\"')
        s = s.replace('\\n', '\\\\n').replace('\\r', '\\\\r').replace('\\t', '\\\\t')
        return '"' + s + '"'
    if isinstance(v, list):
        return '[' + ', '.join(_toml_value(x) for x in v) + ']'
    if isinstance(v, dict):
        parts = [_toml_key(k) + ' = ' + _toml_value(vv) for k, vv in v.items()]
        return '{ ' + ', '.join(parts) + ' }'
    raise TypeError('unsupported TOML value: ' + type(v).__name__)

def _toml_dump(data):
    lines = []
    def emit(d, prefix):
        scalars = []
        tables = []
        for k, v in d.items():
            if isinstance(v, dict) and v:
                tables.append((k, v))
            else:
                scalars.append((k, v))
        for k, v in scalars:
            lines.append(_toml_key(k) + ' = ' + _toml_value(v))
        for k, v in tables:
            path = (prefix + '.' + _toml_key(k)) if prefix else _toml_key(k)
            has_own_scalars = any(not (isinstance(vv, dict) and vv) for vv in v.values())
            if has_own_scalars:
                if lines: lines.append('')
                lines.append('[' + path + ']')
            emit(v, path)
    emit(data, '')
    return '\\n'.join(lines) + '\\n'
`;

/**
 * Inline a Python helper that parses the existing config.toml (empty
 * dict if missing or unparseable). Uses tomllib (3.11+) with a tomli
 * fallback for older images.
 */
const PARSE_HELPER = `
def _read_config(path):
    try:
        import tomllib
    except ImportError:
        import tomli as tomllib
    try:
        with open(path, 'rb') as f:
            return tomllib.load(f)
    except FileNotFoundError:
        return {}
    except Exception:
        return {}
`;

/**
 * Wrap a Python body in a quoted-delimiter here-doc so the shell does
 * not interpret backslashes or double-quotes inside it. The remote `sh`
 * receives a single command string from `gh codespace ssh -- <cmd>`
 * and runs it through its own shell; the here-doc passes the Python
 * source through verbatim regardless.
 */
function pythonHeredoc(body: string): string {
  // `PY_HEREDOC` is unique enough that it won't collide with any line of
  // our script. The single-quoted delimiter (`<<'PY_HEREDOC'`) disables
  // all expansion inside the body.
  return `python3 <<'PY_HEREDOC'\n${body}\nPY_HEREDOC`;
}

/**
 * Build the script that merges our provider into the codespace's
 * config.toml. Idempotent — re-running produces the same file.
 */
export function buildWriteCodexConfigScript(
  port: number,
  model: string,
): string {
  const safeModel = safeModelLiteral(model);
  // The `model` line is omitted when the caller passes an empty string
  // — same convention as the local writer.
  const setModelLine = safeModel ? `data['model'] = '${safeModel}'` : "";
  const body = `
import os
${ATOMIC_DUMP_HELPER}
${PARSE_HELPER}
${TOML_EMITTER}
p = os.path.expanduser('~/.codex/config.toml')
data = _read_config(p)
data['model_provider'] = '${PROVIDER_NAME}'
${setModelLine}
mps = data.get('model_providers') or {}
mps['${PROVIDER_NAME}'] = {
    'name': '${PROVIDER_DISPLAY}',
    'base_url': 'http://127.0.0.1:${port}/codex/v1',
    'wire_api': 'responses',
    'request_timeout': 600,
}
data['model_providers'] = mps
_atomic_dump_text(_toml_dump(data), p)
`;
  return pythonHeredoc(body);
}

/**
 * Build the script that sets only the `model` field. The provider
 * config is left in place; if no provider is configured yet, the next
 * write script invocation will fill it in.
 */
export function buildUpdateCodexModelScript(model: string): string {
  const safeModel = safeModelLiteral(model);
  const body = `
import os
${ATOMIC_DUMP_HELPER}
${PARSE_HELPER}
${TOML_EMITTER}
p = os.path.expanduser('~/.codex/config.toml')
data = _read_config(p)
data['model'] = '${safeModel}'
_atomic_dump_text(_toml_dump(data), p)
`;
  return pythonHeredoc(body);
}

/**
 * Build the script that strips our provider keys. Anything else in the
 * file — other `[model_providers.*]`, user's `[mcp_servers.*]`, root-
 * level options — is left in place. If the file ends up effectively
 * empty, we leave a zero-byte file behind (so inotify watchers don't
 * fire spuriously on a delete).
 */
export function buildRemoveCodexConfigScript(): string {
  const body = `
import os
${ATOMIC_DUMP_HELPER}
${PARSE_HELPER}
${TOML_EMITTER}
p = os.path.expanduser('~/.codex/config.toml')
if not os.path.exists(p):
    raise SystemExit(0)
data = _read_config(p)
if data.get('model_provider') == '${PROVIDER_NAME}':
    del data['model_provider']
mps = data.get('model_providers') or {}
if '${PROVIDER_NAME}' in mps:
    del mps['${PROVIDER_NAME}']
    if not mps:
        data.pop('model_providers', None)
    else:
        data['model_providers'] = mps
if not data:
    _atomic_dump_text('', p)
else:
    _atomic_dump_text(_toml_dump(data), p)
`;
  return pythonHeredoc(body);
}
