/**
 * Shared Python `_atomic_dump` helper used by every agent's remote-config
 * scripts (Claude, Codex, ...) when writing files inside a Codespace.
 *
 * Why this exists: every agent plugin needs the same atomic write
 * primitive — serialize to a sibling tmp file, fsync, os.replace onto the
 * target — but each plugin's script otherwise has nothing in common
 * (different paths, different formats: JSON vs TOML). Keeping the helper
 * here means agents share the byte-for-byte same atomicity guarantee
 * without duplicating the source code, but every agent-specific concern
 * (path, schema, marker keys) stays in the agent's own remote-config.
 *
 * The tmp file lives in the same directory as the target so os.replace()
 * is a same-filesystem rename (POSIX-atomic). fsync before rename guards
 * against a power-loss / kill-9 leaving a zero-byte file behind.
 */
export const ATOMIC_DUMP_HELPER = `
def _atomic_dump_text(text, path):
    import os, tempfile
    d = os.path.dirname(path) or '.'
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.maestro-', suffix='.tmp', dir=d)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, path)
    except Exception:
        try: os.remove(tmp)
        except OSError: pass
        raise

def _atomic_dump(cfg, path):
    import json
    _atomic_dump_text(json.dumps(cfg, indent=2), path)
`;
