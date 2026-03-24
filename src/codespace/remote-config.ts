/**
 * Generates Python3 shell scripts that run inside GitHub Codespaces
 * to configure Claude Code settings.
 *
 * Python3 is used instead of Node.js because it is universally available
 * in all Codespace images.
 */

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
p = os.path.expanduser('~/.claude/settings.json')
os.makedirs(os.path.dirname(p), exist_ok=True)
try:
    cfg = json.load(open(p))
except (FileNotFoundError, json.JSONDecodeError):
    cfg = {}
cfg.setdefault('env', {})
cfg['env']['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:${port}'
cfg['env']['ANTHROPIC_AUTH_TOKEN'] = 'Powered by Agent Maestro Desktop'
cfg['env']['ANTHROPIC_MODEL'] = '${safeModel}'
cfg['env']['AGENT_MAESTRO_MANAGED'] = 'true'
json.dump(cfg, open(p, 'w'), indent=2)
"`;
}

/**
 * Generates a Python3 script that writes ~/.claude.json with
 * hasCompletedOnboarding set to true, so Claude Code skips the onboarding flow.
 */
export function buildWriteOnboardingScript(): string {
  return `python3 -c "
import json, os
p = os.path.expanduser('~/.claude.json')
try:
    cfg = json.load(open(p))
except (FileNotFoundError, json.JSONDecodeError):
    cfg = {}
cfg['hasCompletedOnboarding'] = True
json.dump(cfg, open(p, 'w'), indent=2)
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
json.dump(cfg, open(p, 'w'), indent=2)
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
p = os.path.expanduser('~/.claude/settings.json')
try:
    cfg = json.load(open(p))
except (FileNotFoundError, json.JSONDecodeError):
    exit(0)
env = cfg.get('env', {})
if env.get('AGENT_MAESTRO_MANAGED') != 'true':
    exit(0)
env['ANTHROPIC_MODEL'] = '${safeModel}'
json.dump(cfg, open(p, 'w'), indent=2)
"`;
}
