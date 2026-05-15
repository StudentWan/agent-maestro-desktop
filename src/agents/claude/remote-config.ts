/**
 * Generates Python3 shell scripts that run inside GitHub Codespaces
 * to configure Claude Code settings.
 *
 * Python3 is used instead of Node.js because it is universally available
 * in all Codespace images.
 *
 * All writes are ATOMIC: we serialize to a sibling tmp file, fsync it, then
 * os.replace() onto the target. The atomicity helper is shared with all
 * other agent plugins via `src/codespace/atomic-dump.ts` — we only inline
 * Claude-specific content (paths, env keys, marker name) here.
 */
import { ATOMIC_DUMP_HELPER } from "../../codespace/atomic-dump";

/** Shell command verifying the Claude marker is present in remote settings. */
export const CLAUDE_VERIFY_MARKER_COMMAND =
  "cat ~/.claude/settings.json 2>/dev/null | grep -c AGENT_MAESTRO_MANAGED || true";

/**
 * Escape a string for safe embedding in a Python string literal.
 * Removes single quotes and backslashes to prevent injection.
 */
function escapePythonString(value: string): string {
  return value.replace(/[\\']/g, "");
}

/**
 * Generates a Python3 script that writes ~/.claude/settings.json with
 * proxy URL, auth token, model name, and the AGENT_MAESTRO_MANAGED marker.
 */
export function buildWriteConfigScript(port: number, model: string): string {
  const safeModel = escapePythonString(model);
  return `python3 -c "
import json, os
${ATOMIC_DUMP_HELPER}
p = os.path.expanduser('~/.claude/settings.json')
try:
    cfg = json.load(open(p))
except (FileNotFoundError, json.JSONDecodeError):
    cfg = {}
cfg.setdefault('env', {})
cfg['env']['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:${port}'
cfg['env']['ANTHROPIC_AUTH_TOKEN'] = 'Powered by Agent Maestro Desktop'
cfg['env']['ANTHROPIC_MODEL'] = '${safeModel}'
cfg['env']['AGENT_MAESTRO_MANAGED'] = 'true'
_atomic_dump(cfg, p)
"`;
}

/**
 * Generates a Python3 script that writes ~/.claude.json with
 * hasCompletedOnboarding set to true, so Claude Code skips the onboarding flow.
 */
export function buildWriteOnboardingScript(): string {
  return `python3 -c "
import json, os
${ATOMIC_DUMP_HELPER}
p = os.path.expanduser('~/.claude.json')
try:
    cfg = json.load(open(p))
except (FileNotFoundError, json.JSONDecodeError):
    cfg = {}
cfg['hasCompletedOnboarding'] = True
_atomic_dump(cfg, p)
"`;
}

/**
 * Generates a Python3 script that removes Agent Maestro keys from
 * ~/.claude/settings.json. Only removes keys if the AGENT_MAESTRO_MANAGED
 * marker is present, so it never clobbers manually configured settings.
 */
export function buildRemoveConfigScript(): string {
  return `python3 -c "
import json, os
${ATOMIC_DUMP_HELPER}
p = os.path.expanduser('~/.claude/settings.json')
try:
    cfg = json.load(open(p))
except (FileNotFoundError, json.JSONDecodeError):
    exit(0)
env = cfg.get('env', {})
if env.get('AGENT_MAESTRO_MANAGED') != 'true':
    exit(0)
for key in ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'AGENT_MAESTRO_MANAGED']:
    env.pop(key, None)
if not env:
    cfg.pop('env', None)
_atomic_dump(cfg, p)
"`;
}

/**
 * Generates a Python3 script that updates only the ANTHROPIC_MODEL key in
 * ~/.claude/settings.json. Only updates if the AGENT_MAESTRO_MANAGED marker
 * is present, ensuring it only touches settings it owns.
 */
export function buildUpdateModelScript(model: string): string {
  const safeModel = escapePythonString(model);
  return `python3 -c "
import json, os
${ATOMIC_DUMP_HELPER}
p = os.path.expanduser('~/.claude/settings.json')
try:
    cfg = json.load(open(p))
except (FileNotFoundError, json.JSONDecodeError):
    exit(0)
env = cfg.get('env', {})
if env.get('AGENT_MAESTRO_MANAGED') != 'true':
    exit(0)
env['ANTHROPIC_MODEL'] = '${safeModel}'
_atomic_dump(cfg, p)
"`;
}
