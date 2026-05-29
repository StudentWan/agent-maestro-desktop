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
 * Requires Python 3 in the codespace image (true for every official
 * `mcr.microsoft.com/devcontainers/...` base). Parsing uses `tomllib`
 * (3.11+) or `tomli` when available; otherwise falls back to an
 * embedded pure-stdlib parser that covers the subset of TOML real
 * Codex configs use. If parsing fails the script still falls through
 * to `{}` — the tunnel stays up because Codex's `criticalForTunnel`
 * is false.
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
    def reorder_tables(prefix, tables):
        if prefix == '':
            front = [item for item in tables if item[0] == 'model_providers']
            rest = [item for item in tables if item[0] != 'model_providers']
            return front + rest
        if prefix == 'model_providers':
            front = [item for item in tables if item[0] == 'agent-maestro']
            rest = [item for item in tables if item[0] != 'agent-maestro']
            return front + rest
        return tables

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
        tables = reorder_tables(prefix, tables)
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
 * dict if missing or unparseable). Tries `tomllib` (3.11+) and `tomli`
 * first; falls back to an embedded pure-stdlib parser when neither is
 * available — which is the common case on Codespace images shipping
 * Python 3.10 with no third-party packages.
 *
 * The embedded parser handles the subset of TOML that realistic Codex
 * configs use: scalars (strings, ints, floats, bools), arrays of
 * scalars, inline tables, dotted keys, `[a.b.c]` section headers, and
 * line comments. Multi-line strings and array-of-tables `[[a]]` are
 * not supported — if encountered we fall through to `{}` (same
 * silent-fallback contract as before: a broken file gets overwritten).
 */
const PARSE_HELPER = `
def _parse_toml(text):
    src = text
    n = len(src)
    pos = [0]

    def err(msg):
        line = src.count('\\n', 0, pos[0]) + 1
        raise ValueError('TOML parse error at line %d: %s' % (line, msg))

    def peek(off=0):
        p = pos[0] + off
        return src[p] if p < n else ''

    def skip_ws():
        while pos[0] < n and src[pos[0]] in ' \\t':
            pos[0] += 1

    def skip_ws_nl_comments():
        while pos[0] < n:
            c = src[pos[0]]
            if c in ' \\t\\r\\n':
                pos[0] += 1
            elif c == '#':
                while pos[0] < n and src[pos[0]] != '\\n':
                    pos[0] += 1
            else:
                break

    def skip_eol():
        skip_ws()
        if pos[0] < n and src[pos[0]] == '#':
            while pos[0] < n and src[pos[0]] != '\\n':
                pos[0] += 1
        if pos[0] < n and src[pos[0]] == '\\n':
            pos[0] += 1

    def parse_basic_string():
        pos[0] += 1
        if peek() == '"' and peek(1) == '"':
            err('multi-line strings not supported')
        out = []
        while pos[0] < n:
            c = src[pos[0]]
            if c == '"':
                pos[0] += 1
                return ''.join(out)
            if c == '\\\\':
                pos[0] += 1
                if pos[0] >= n: err('unterminated escape')
                e = src[pos[0]]; pos[0] += 1
                if   e == 'n':  out.append('\\n')
                elif e == 'r':  out.append('\\r')
                elif e == 't':  out.append('\\t')
                elif e == 'b':  out.append('\\b')
                elif e == 'f':  out.append('\\f')
                elif e == '\\\\': out.append('\\\\')
                elif e == '"':  out.append('"')
                elif e == '/':  out.append('/')
                elif e == 'u':
                    out.append(chr(int(src[pos[0]:pos[0]+4], 16))); pos[0] += 4
                elif e == 'U':
                    out.append(chr(int(src[pos[0]:pos[0]+8], 16))); pos[0] += 8
                else:
                    err('bad escape')
            elif c == '\\n':
                err('newline in basic string')
            else:
                out.append(c); pos[0] += 1
        err('unterminated string')

    def parse_literal_string():
        pos[0] += 1
        if peek() == "'" and peek(1) == "'":
            err('multi-line strings not supported')
        start = pos[0]
        while pos[0] < n and src[pos[0]] != "'":
            if src[pos[0]] == '\\n':
                err('newline in literal string')
            pos[0] += 1
        if pos[0] >= n: err('unterminated literal string')
        s = src[start:pos[0]]; pos[0] += 1
        return s

    def parse_key():
        c = peek()
        if c == '"': return parse_basic_string()
        if c == "'": return parse_literal_string()
        start = pos[0]
        while pos[0] < n and (src[pos[0]].isalnum() or src[pos[0]] in '_-'):
            pos[0] += 1
        if start == pos[0]: err('expected key')
        return src[start:pos[0]]

    def parse_dotted_key():
        keys = [parse_key()]
        while True:
            skip_ws()
            if peek() == '.':
                pos[0] += 1; skip_ws()
                keys.append(parse_key())
            else:
                break
        return keys

    def parse_number():
        start = pos[0]
        if peek() in '+-': pos[0] += 1
        while pos[0] < n and src[pos[0]] in '0123456789._eE+-':
            pos[0] += 1
        s = src[start:pos[0]].replace('_', '')
        if not s: err('expected number')
        try:
            if any(c in s for c in '.eE'): return float(s)
            return int(s)
        except ValueError:
            err('bad number')

    def parse_value():
        c = peek()
        if c == '"':  return parse_basic_string()
        if c == "'":  return parse_literal_string()
        if c == '[':  return parse_array()
        if c == '{':  return parse_inline_table()
        if src[pos[0]:pos[0]+4] == 'true':  pos[0] += 4; return True
        if src[pos[0]:pos[0]+5] == 'false': pos[0] += 5; return False
        return parse_number()

    def parse_array():
        pos[0] += 1
        items = []
        skip_ws_nl_comments()
        if peek() == ']':
            pos[0] += 1; return items
        while True:
            items.append(parse_value())
            skip_ws_nl_comments()
            if peek() == ',':
                pos[0] += 1; skip_ws_nl_comments()
                if peek() == ']':
                    pos[0] += 1; return items
            elif peek() == ']':
                pos[0] += 1; return items
            else:
                err('expected , or ] in array')

    def parse_inline_table():
        pos[0] += 1
        table = {}
        skip_ws()
        if peek() == '}':
            pos[0] += 1; return table
        while True:
            keys = parse_dotted_key()
            skip_ws()
            if peek() != '=': err('expected = in inline table')
            pos[0] += 1; skip_ws()
            val = parse_value()
            t = table
            for k in keys[:-1]:
                if k not in t: t[k] = {}
                t = t[k]
            t[keys[-1]] = val
            skip_ws()
            if peek() == ',':
                pos[0] += 1; skip_ws()
            elif peek() == '}':
                pos[0] += 1; return table
            else:
                err('expected , or } in inline table')

    result = {}
    current = result
    skip_ws_nl_comments()
    while pos[0] < n:
        if peek() == '[':
            pos[0] += 1
            if peek() == '[':
                err('array-of-tables not supported')
            skip_ws()
            keys = parse_dotted_key()
            skip_ws()
            if peek() != ']': err('expected ]')
            pos[0] += 1
            d = result
            for k in keys:
                if k not in d: d[k] = {}
                if not isinstance(d[k], dict):
                    err('key collides with non-table value')
                d = d[k]
            current = d
        else:
            keys = parse_dotted_key()
            skip_ws()
            if peek() != '=':
                err('expected =')
            pos[0] += 1; skip_ws()
            val = parse_value()
            t = current
            for k in keys[:-1]:
                if k not in t: t[k] = {}
                t = t[k]
            t[keys[-1]] = val
        skip_eol()
        skip_ws_nl_comments()
    return result

def _read_config(path):
    try:
        with open(path, 'rb') as f:
            raw = f.read()
    except FileNotFoundError:
        return {}
    except Exception:
        return {}
    if not raw.strip():
        return {}
    try:
        text = raw.decode('utf-8')
    except Exception:
        return {}
    # Try tomllib (3.11+) then tomli; if neither is importable, fall
    # back to the embedded parser. Many Codespace images ship Python
    # 3.10 with no tomli — without this fallback the whole script
    # crashed on the unhandled ImportError.
    parsers = []
    try:
        import tomllib
        parsers.append(tomllib.loads)
    except ImportError:
        try:
            import tomli
            parsers.append(tomli.loads)
        except ImportError:
            pass
    parsers.append(_parse_toml)
    for parse in parsers:
        try:
            return parse(text)
        except Exception:
            continue
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
