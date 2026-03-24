# Codespace Proxy Support — Design Spec

**Date:** 2026-03-24
**Status:** Approved
**Author:** Agent Maestro Desktop Team

## 1. Overview

### Problem

Agent Maestro Desktop runs a local HTTP proxy on `127.0.0.1:23337` that bridges Claude Code (Anthropic API format) to GitHub Copilot API. When Claude Code runs inside a GitHub Codespace (cloud container), it cannot reach the user's local proxy server.

### Solution

Add SSH reverse tunnel support so that the local proxy appears as `localhost:23337` inside the Codespace. The desktop app handles all configuration — the Codespace-side experience is zero-config.

### Core Scenario

```
Direction: Codespace → Local Desktop (one-way)
Tunnel:    SSH reverse tunnel via `gh codespace ssh -- -R`
Auth:      Delegate Codespace API calls to gh CLI (separate from app's Copilot OAuth)
Scaling:   Support multiple concurrent Codespace connections
```

## 2. Architecture

```
┌──────────────────────── GitHub Codespace ────────────────────────┐
│                                                                  │
│  [Claude Code CLI]                                               │
│       │  POST http://localhost:23337/v1/messages                 │
│       ↓                                                          │
│  [localhost:23337] ←── SSH reverse tunnel ──┐                    │
│                                             │                    │
│  [~/.claude/settings.json]                  │                    │
│    ANTHROPIC_BASE_URL=http://127.0.0.1:23337                    │
│    ANTHROPIC_AUTH_TOKEN=...                  │                    │
│  [~/.claude.json]                           │                    │
│    hasCompletedOnboarding=true               │                    │
└─────────────────────────────────────────────│────────────────────┘
                                              │
                            SSH -R 23337:127.0.0.1:23337
                            (via gh codespace ssh)
                                              │
┌──────────────────────── User's Desktop ─────│────────────────────┐
│                                              │                    │
│  [Agent Maestro Desktop]                     │                    │
│    ├── Existing Proxy Server (127.0.0.1:23337)                   │
│    ├── Codespace Manager (NEW)               │                    │
│    │    ├── List user's Codespaces (via gh CLI)                   │
│    │    ├── Manage SSH tunnel processes       │                    │
│    │    ├── Configure remote Claude settings  │                    │
│    │    ├── Propagate model changes           │                    │
│    │    └── Health check & auto-reconnect     │                    │
│    └── UI: Codespace Panel (NEW)             │                    │
│         ├── Codespace list + status           │                    │
│         ├── Connect / Disconnect buttons      │                    │
│         └── Connection uptime display         │                    │
│                                                                   │
│  Existing flow (unchanged):                                       │
│    Proxy → Anthropic↔OpenAI conversion → Copilot API → response  │
└───────────────────────────────────────────────────────────────────┘
```

### How It Works

1. User clicks "Connect" on a Codespace in the desktop UI.
2. Desktop app spawns `gh codespace ssh --codespace <name> -- -R 23337:127.0.0.1:23337 -N`.
3. This creates an SSH reverse tunnel: Codespace's `localhost:23337` maps to the desktop's `127.0.0.1:23337`.
4. Desktop app runs a second SSH command to write `~/.claude/settings.json` and `~/.claude.json` inside the Codespace.
5. Claude Code in the Codespace sends requests to `localhost:23337` → tunnel → desktop proxy → Copilot API.
6. Responses flow back through the same tunnel.

### Why SSH Reverse Tunnel

| Approach | Pros | Cons |
|----------|------|------|
| **SSH reverse tunnel (chosen)** | Zero third-party deps, uses GitHub infra, secure | Requires gh CLI |
| WebSocket tunnel | Low latency, SSE-native | Desktop has no public IP (NAT/firewall) |
| Cloudflare/ngrok | Simple setup | Third-party dependency, security risk |

SSH reverse tunnel won because:
- No public IP needed (tunnel initiated from desktop → Codespace via GitHub)
- Leverages GitHub's existing SSH infrastructure
- `gh codespace ssh` handles all the complexity (keys, negotiation)
- Stable, well-tested protocol

## 3. New Module: `src/codespace/`

### 3.1 File Structure

```
src/codespace/
├── codespace-manager.ts    # Core orchestration logic
├── ssh-tunnel.ts           # SSH tunnel process wrapper
├── gh-cli.ts               # gh CLI detection & operations
├── remote-config.ts        # Remote Claude config management
└── types.ts                # TypeScript type definitions
```

### 3.2 Types (`types.ts`)

```typescript
export type CodespaceConnectionState =
  | 'available'       // Listed but not connected
  | 'connecting'      // SSH tunnel being established
  | 'connected'       // Tunnel active, Claude configured
  | 'disconnecting'   // Tearing down tunnel + cleaning config
  | 'reconnecting'    // Auto-reconnecting after failure
  | 'error';          // Connection failed

// Use string for state to handle unknown API values gracefully
export type CodespaceApiState = string;

// Known states for display logic
export const KNOWN_CODESPACE_STATES = {
  AVAILABLE: 'Available',
  SHUTDOWN: 'Shutdown',
  STARTING: 'Starting',
  REBUILDING: 'Rebuilding',
  QUEUED: 'Queued',
  ARCHIVED: 'Archived',
  SHUTTING_DOWN: 'ShuttingDown',
  FAILED: 'Failed',
  EXPORTING: 'Exporting',
  UPDATING: 'Updating',
  PROVISIONING: 'Provisioning',
} as const;

export interface CodespaceInfo {
  id: number;
  name: string;
  displayName: string;
  repository: string;
  state: CodespaceApiState;
  machine: string;
  lastUsedAt: string;
}

export interface CodespaceConnection {
  id: string;                        // Codespace name (unique identifier)
  info: CodespaceInfo;               // API-fetched metadata
  connectionState: CodespaceConnectionState;
  remotePort: number;                // Port inside Codespace (default 23337)
  localPort: number;                 // Local proxy port (default 23337)
  connectedAt: number | null;        // Timestamp
  lastHealthCheck: number | null;    // Timestamp
  reconnectAttempts: number;         // Current retry count
  errorMessage?: string;
}

export interface GhCliStatus {
  installed: boolean;
  version?: string;
  meetsMinVersion: boolean;          // >= 2.13.0
  authenticated: boolean;
  hasCodespaceScope: boolean;
}

// Minimum gh CLI version required
export const MIN_GH_CLI_VERSION = '2.13.0';
```

### 3.3 gh CLI Wrapper (`gh-cli.ts`)

Responsibilities:
- Detect gh CLI installation (`gh --version`) and validate version >= 2.13.0
- Check auth status (`gh auth status`)
- List Codespaces via `gh api /user/codespaces` (uses gh CLI's own auth token)
- Execute SSH commands as child processes
- Execute remote commands via `gh codespace ssh` with 15s timeout

Key functions:
```typescript
checkGhCli(): Promise<GhCliStatus>
listCodespaces(): Promise<CodespaceInfo[]>         // via gh api, not direct REST
startCodespace(name: string): Promise<void>        // via gh api
sshTunnel(codespaceName: string, remotePort: number, localPort: number): ChildProcess
executeRemoteCommand(codespaceName: string, command: string, timeoutMs?: number): Promise<string>
```

**Important: Codespace API calls use `gh api` instead of direct REST API calls.** The app's OAuth token uses a Copilot-specific client ID (`Iv1.b507a08c87ecfe98`) that may not support the `codespace` scope. By delegating to `gh api`, we use the gh CLI's own authentication which already has (or can be granted) the correct scopes. This avoids modifying the app's OAuth flow entirely.

### 3.4 SSH Tunnel (`ssh-tunnel.ts`)

Wraps the SSH tunnel child process with:
- Process lifecycle management (spawn, monitor, kill)
- Connection state detection (watching stderr for connection established)
- Auto-reconnect with exponential backoff (1s → 2s → 4s → 8s → 16s, max 5 retries)
- Health check via SSH keepalive (`ServerAliveInterval=15`, `ServerAliveCountMax=3`)
- Application-level health check: periodically run `gh codespace ssh -- curl -s http://127.0.0.1:<PORT>/health` to verify end-to-end connectivity (the proxy already exposes a `GET /health` route in `src/proxy/routes/health.ts`)
- Graceful shutdown on app exit

SSH command:
```bash
gh codespace ssh \
  --codespace <CODESPACE_NAME> \
  -- -R <REMOTE_PORT>:127.0.0.1:<LOCAL_PORT> \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -N
```

Note: `StrictHostKeyChecking=no` is omitted — `gh codespace ssh` handles host key verification internally through GitHub's infrastructure. If testing reveals it's needed, it can be added back with a security comment.

### 3.5 Remote Config (`remote-config.ts`)

Manages Claude Code configuration inside the Codespace. See Section 10 for the scripts.

Key functions:
```typescript
writeRemoteConfig(codespaceName: string, port: number, model: string): Promise<void>
removeRemoteConfig(codespaceName: string): Promise<void>
updateRemoteModel(codespaceName: string, model: string): Promise<void>
```

### 3.6 Codespace Manager (`codespace-manager.ts`)

Central orchestrator. Responsibilities:
- Maintains a `Map<string, CodespaceConnection>` of all connections
- Coordinates: list → connect → configure → monitor → disconnect
- Handles port allocation for multi-Codespace (23337, 23338, 23339...)
- Emits events for UI updates
- Cleans up on app exit (disconnect all, restore remote configs)
- **Propagates model changes**: When the user changes the selected model in the UI, updates all connected Codespaces' `~/.claude/settings.json`

Connection flow (with port conflict retry):
1. Allocate port (next available starting from proxy port)
2. Spawn SSH tunnel process
3. Wait for connection established (or timeout at 30s)
4. **If port conflict detected** (stderr: "bind: Address already in use"):
   - Kill SSH process
   - Allocate next port
   - Retry from step 2 (max 3 port retries)
5. Execute remote command to write `~/.claude/settings.json` AND `~/.claude.json`
6. Start health check timer (30s interval)
7. Emit `connected` status

Disconnection flow:
1. Emit `disconnecting` status
2. Execute remote command to remove Claude config entries (best-effort, 15s timeout)
3. Kill SSH tunnel process
4. Free allocated port
5. Emit `available` status

Model change propagation:
- Listen for `models:set-selected` events
- For each connected Codespace, run `updateRemoteModel()` to update `ANTHROPIC_MODEL` in remote `~/.claude/settings.json`

## 4. Authentication

### No Changes to App's OAuth Flow

The app's existing OAuth login (client ID `Iv1.b507a08c87ecfe98`, scope `read:user`) remains **unchanged**. This token is used exclusively for Copilot API access.

### Codespace API Auth via gh CLI

All Codespace-related API calls are delegated to the `gh` CLI:
- `gh api /user/codespaces` — list Codespaces
- `gh api -X POST /user/codespaces/{name}/start` — start a Codespace
- `gh codespace ssh` — SSH tunnel and remote commands

This means:
- **No scope conflict**: The app's Copilot OAuth token is not used for Codespace operations
- **No re-login needed**: Existing users can use Codespace features immediately if `gh` CLI is authenticated
- **Single auth dependency**: `gh auth login` with `codespace` scope is the only requirement

### Prerequisites (displayed in UI)

1. `gh` CLI installed (version >= 2.13.0)
2. `gh auth login` completed
3. Codespace scope available — if not: `gh auth refresh --scopes codespace`

## 5. IPC Channels

### New Channels

Integrated into the existing types in `src/shared/ipc-channels.ts`:

```typescript
// Request/Response channels — added to the existing IpcChannels union type
// (used with ipcMain.handle / ipcRenderer.invoke)
export type IpcChannels =
  | 'auth:start-login'
  // ... existing channels ...
  | 'codespace:check-gh-cli'
  | 'codespace:list'
  | 'codespace:connect'
  | 'codespace:disconnect'
  | 'codespace:disconnect-all'
  | 'codespace:get-connections';

// Event channels — added to the existing IpcEvents union type
// (used with webContents.send / ipcRenderer.on)
export type IpcEvents =
  | 'auth:status-changed'
  // ... existing events ...
  | 'codespace:status-changed'
  | 'codespace:connection-error';
```

### Preload Bridge Extension (`src/preload.ts`)

```typescript
// Added to window.copilotBridge
codespace: {
  checkGhCli(): Promise<GhCliStatus>,
  list(): Promise<CodespaceInfo[]>,
  connect(name: string): Promise<CodespaceConnection>,
  disconnect(name: string): Promise<void>,
  disconnectAll(): Promise<void>,
  getConnections(): Promise<CodespaceConnection[]>,
  onStatusChanged(callback: (connection: CodespaceConnection) => void): () => void,
  onError(callback: (error: { name: string; message: string }) => void): () => void,
}
```

Note: Codespace methods are namespaced under `copilotBridge.codespace.*` to maintain separation of concerns from the existing Copilot-related methods.

## 6. UI: Codespace Panel

### New Component: `src/renderer/components/CodespacePanel.tsx`

Placed alongside existing panels (AuthPanel, ProxyPanel, etc.).

### Layout

```
┌─── Codespaces ──────────────────────────────────┐
│                                                  │
│  gh CLI: ✅ Installed (v2.x.x)                  │
│                                                  │
│  [🔄 Refresh]                                    │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ 🟢 friendly-garbanzo-abc123               │  │
│  │    repo: user/my-project                   │  │
│  │    port: 23337 → 23337                     │  │
│  │    uptime: 2h 15m                          │  │
│  │    [Disconnect]                            │  │
│  └────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────┐  │
│  │ ⚪ scaling-waddle-def456                   │  │
│  │    repo: user/other-project                │  │
│  │    state: Available                        │  │
│  │    [Connect]                               │  │
│  └────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────┐  │
│  │ 🔴 turbo-computing-ghi789                 │  │
│  │    repo: user/third-project                │  │
│  │    error: SSH tunnel disconnected          │  │
│  │    [Reconnect]  [Dismiss]                  │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Status Indicators

| Icon | State | Meaning |
|------|-------|---------|
| 🟢 | `connected` | SSH tunnel active, Claude configured |
| 🟡 | `connecting` / `reconnecting` / `disconnecting` | In-progress operation |
| ⚪ | `available` | Codespace running, not connected |
| 🔴 | `error` | Connection failed |

### Interactions

- **Connect**: Establish SSH tunnel + configure Claude
- **Disconnect**: Tear down tunnel + clean up Claude config
- **Reconnect**: Retry after error
- **Dismiss**: Clear error state, return to `available`
- **Refresh**: Re-fetch Codespace list from API

Note: Per-connection request count is **not** tracked in v1. The proxy handles all requests uniformly through a single port, making per-Codespace attribution impractical without adding overhead. This can be revisited if needed.

## 7. Codespace Discovery

### API via gh CLI

```bash
gh api /user/codespaces --jq '.codespaces'
```

This delegates authentication to the gh CLI's own token, avoiding scope conflicts with the app's Copilot OAuth token.

### Response Filtering

- Show Codespaces with `state: "Available"` as connectable (🟢 Connect button)
- Show `Shutdown` Codespaces with "Start & Connect" option
- Filter out other states (Starting, Rebuilding, etc.) — show as greyed out
- Sort by `last_used_at` descending (most recent first)

### Polling

- Initial fetch on panel mount
- Manual refresh via button
- Auto-refresh every 60 seconds when panel is visible
- **Pause polling** when app is minimized/hidden (reduce API calls)
- Respect `X-RateLimit-Remaining` header; back off if < 100 remaining

## 8. Multi-Codespace Port Allocation

When connecting multiple Codespaces simultaneously:

| Connection | Remote Port (Codespace) | Local Port (Desktop) |
|------------|------------------------|---------------------|
| 1st | 23337 | 23337 |
| 2nd | 23338 | 23337 |
| 3rd | 23339 | 23337 |

- The **local port** is always the proxy server port (23337).
- The **remote port** varies per connection to avoid conflicts.
- Each Codespace's `~/.claude/settings.json` points to its unique remote port.
- Port allocation starts from the configured proxy port and increments.
- **Port conflict retry**: If SSH reports "bind: Address already in use", the manager automatically tries the next port (see Section 3.6 connection flow).

## 9. Error Handling

| Scenario | Detection | Response |
|----------|-----------|----------|
| gh CLI not installed | `gh --version` fails | Show install guide with download link |
| gh CLI version too old | Version parse < 2.13.0 | Show upgrade instructions |
| gh CLI not authenticated | `gh auth status` fails | Prompt `gh auth login` |
| Missing codespace scope | `gh api` returns 403 | Prompt `gh auth refresh --scopes codespace` |
| SSH connection timeout | 30s timer after spawn | Retry with backoff |
| SSH tunnel drops | Process exit event | Auto-reconnect (exponential backoff: 1→2→4→8→16s, max 5 tries) |
| Remote port occupied | SSH stderr "bind: Address already in use" | Allocate next port, retry (max 3 port retries) |
| Codespace stopped/deleted | SSH process exits + API check | Notify user, remove connection |
| Proxy server not running | Pre-connect check | Auto-start proxy, then connect |
| Remote config write fails | SSH command exit code != 0 | Log warning, connection still established (config can be retried) |
| Remote command timeout | 15s timer | Abort command, log warning |
| App exit | `before-quit` event | Disconnect all tunnels, best-effort clean remote configs |

## 10. Remote Claude Configuration

### Runtime Detection

The remote config scripts use `python3` instead of `node` for JSON manipulation, since `python3` is universally available in all GitHub Codespace base images (including non-Node.js environments like Python, Go, Rust, Java).

### On Connect

Execute via `gh codespace ssh` (with 15s timeout):

**Step 1: Write `~/.claude/settings.json`:**
```bash
mkdir -p ~/.claude && \
python3 -c "
import json, os
p = os.path.expanduser('~/.claude/settings.json')
try:
    cfg = json.load(open(p))
except (FileNotFoundError, json.JSONDecodeError):
    cfg = {}
cfg.setdefault('env', {})
cfg['env']['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:<PORT>'
cfg['env']['ANTHROPIC_AUTH_TOKEN'] = 'Powered by Agent Maestro Desktop'
cfg['env']['ANTHROPIC_MODEL'] = '<MODEL>'
cfg['env']['AGENT_MAESTRO_MANAGED'] = 'true'
json.dump(cfg, open(p, 'w'), indent=2)
"
```

**Step 2: Write `~/.claude.json` (onboarding bypass):**
```bash
python3 -c "
import json, os
p = os.path.expanduser('~/.claude.json')
try:
    cfg = json.load(open(p))
except (FileNotFoundError, json.JSONDecodeError):
    cfg = {}
cfg['hasCompletedOnboarding'] = True
json.dump(cfg, open(p, 'w'), indent=2)
"
```

### On Disconnect

Remove only the entries set by Agent Maestro (detected via `AGENT_MAESTRO_MANAGED` marker):
```bash
python3 -c "
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
"
```

### On Model Change

Update only `ANTHROPIC_MODEL` on all connected Codespaces (only if managed):
```bash
python3 -c "
import json, os
p = os.path.expanduser('~/.claude/settings.json')
try:
    cfg = json.load(open(p))
except (FileNotFoundError, json.JSONDecodeError):
    exit(0)
env = cfg.get('env', {})
if env.get('AGENT_MAESTRO_MANAGED') != 'true':
    exit(0)
env['ANTHROPIC_MODEL'] = '<NEW_MODEL>'
json.dump(cfg, open(p, 'w'), indent=2)
"
```

### Safety Guarantees

- **Marker-based ownership**: `AGENT_MAESTRO_MANAGED=true` in env indicates Agent Maestro controls the config
- **On disconnect**: Only removes values if the marker is present
- **On model change**: Only updates if the marker is present
- **Merge semantics**: All scripts read-modify-write, never overwrite the entire file
- **Timeout**: All remote commands have a 15s timeout to prevent hanging

## 11. Dependencies

### External (User must install)

| Dependency | Required For | Detection | Min Version |
|------------|-------------|-----------|-------------|
| `gh` CLI | SSH tunnel + Codespace API | `gh --version` | >= 2.13.0 |
| SSH | Underlying transport | Bundled with gh CLI | — |

### Internal (No new npm packages)

The implementation uses only:
- `child_process` (Node.js built-in) — spawning gh/SSH processes
- Existing project dependencies (Hono, React, electron-store, etc.)

## 12. Security Considerations

- SSH tunnels are encrypted end-to-end
- The proxy only listens on `127.0.0.1` (both local and inside Codespace)
- GitHub tokens are never sent through the tunnel (only proxy traffic)
- Remote Claude config uses a placeholder auth token (not a real secret)
- On disconnect, remote config is cleaned up (marker-based ownership)
- gh CLI handles SSH key management and host verification (no keys stored by the app)
- No `StrictHostKeyChecking=no` — gh CLI handles host key verification through GitHub's infrastructure

## 13. Testing Strategy

### Unit Tests
- `codespace-manager.ts`: Connection lifecycle, port allocation, state transitions, model propagation
- `gh-cli.ts`: Command construction, output parsing, version comparison
- `ssh-tunnel.ts`: Process management, reconnect logic, port conflict retry
- `remote-config.ts`: Script generation, parameter escaping

### Integration Tests
- Full connect → configure → disconnect flow (mocked gh CLI)
- Multi-Codespace port allocation with port conflicts
- Model change propagation to multiple connections
- Error recovery scenarios (disconnect during connect, etc.)

### E2E Tests
- Connect/disconnect flow with mocked `gh` CLI binary
- UI interaction: click Connect → verify state transitions → click Disconnect
- Error display: simulate gh CLI failure → verify error UI

### Manual Testing
- Real Codespace connection with live gh CLI
- SSH tunnel stability over extended periods
- Claude Code end-to-end: request through tunnel → Copilot API → response
- Non-Node.js Codespace (e.g., Python devcontainer) to verify python3-based config scripts
