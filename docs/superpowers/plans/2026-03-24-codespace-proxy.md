# Codespace Proxy Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Claude Code running inside GitHub Codespaces to proxy requests through the local Agent Maestro Desktop via SSH reverse tunnels.

**Architecture:** SSH reverse tunnel (`gh codespace ssh -- -R`) maps the local proxy port into the Codespace. A new `src/codespace/` module manages tunnel lifecycle, gh CLI operations, and remote Claude configuration. A React `CodespacePanel` component provides the UI.

**Tech Stack:** Electron 34, React 19, TypeScript 5.7, Hono 4.6, Vitest, child_process (Node built-in), gh CLI (external dependency)

**Spec:** `docs/superpowers/specs/2026-03-24-codespace-proxy-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/codespace/types.ts` | TypeScript types for Codespace connections, states, gh CLI status |
| `src/codespace/gh-cli.ts` | gh CLI detection, version check, command execution wrapper |
| `src/codespace/ssh-tunnel.ts` | SSH tunnel process lifecycle, reconnect logic |
| `src/codespace/remote-config.ts` | Generate python3 scripts for remote Claude configuration |
| `src/codespace/codespace-manager.ts` | Central orchestrator: list, connect, disconnect, port allocation, model propagation |
| `src/renderer/components/CodespacePanel.tsx` | React UI for Codespace management |
| `src/codespace/__tests__/gh-cli.test.ts` | Tests for gh CLI wrapper |
| `src/codespace/__tests__/ssh-tunnel.test.ts` | Tests for SSH tunnel lifecycle |
| `src/codespace/__tests__/remote-config.test.ts` | Tests for remote config script generation |
| `src/codespace/__tests__/codespace-manager.test.ts` | Tests for orchestrator logic |

### Modified Files
| File | Change |
|------|--------|
| `src/shared/ipc-channels.ts` | Add 6 codespace IPC channels + 2 events |
| `vitest.config.ts` | Add `src/codespace/**/*.ts` to coverage include |
| `tsconfig.json` | Add `@codespace/*` path alias |
| `src/preload.ts` | Add `codespace` namespace to bridge API |
| `src/main/ipc-handlers.ts` | Register codespace IPC handlers, integrate with cleanup |
| `src/main/index.ts` | Add codespace cleanup to `before-quit` |
| `src/renderer/App.tsx` | Add CodespacePanel to layout |
| `src/shared/constants.ts` | Add codespace-related constants |

---

## Task 1: Codespace Types

**Files:**
- Create: `src/codespace/types.ts`

- [ ] **Step 1: Create types file**

```typescript
// src/codespace/types.ts

export type CodespaceConnectionState =
  | "available"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "reconnecting"
  | "error";

export type CodespaceApiState = string;

export const KNOWN_CODESPACE_STATES = {
  AVAILABLE: "Available",
  SHUTDOWN: "Shutdown",
  STARTING: "Starting",
  REBUILDING: "Rebuilding",
  QUEUED: "Queued",
  ARCHIVED: "Archived",
  SHUTTING_DOWN: "ShuttingDown",
  FAILED: "Failed",
  EXPORTING: "Exporting",
  UPDATING: "Updating",
  PROVISIONING: "Provisioning",
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
  id: string;
  info: CodespaceInfo;
  connectionState: CodespaceConnectionState;
  remotePort: number;
  localPort: number;
  connectedAt: number | null;
  lastHealthCheck: number | null;
  reconnectAttempts: number;
  errorMessage?: string;
}

export interface GhCliStatus {
  installed: boolean;
  version?: string;
  meetsMinVersion: boolean;
  authenticated: boolean;
  hasCodespaceScope: boolean;
}

export const MIN_GH_CLI_VERSION = "2.13.0";
```

- [ ] **Step 2: Verify file compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/codespace/types.ts
git commit -m "feat(codespace): add TypeScript type definitions"
```

---

## Task 2: Shared Constants, IPC Channels & Config Updates

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/ipc-channels.ts`
- Modify: `vitest.config.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Add codespace constants to `src/shared/constants.ts`**

Add at end of file (after line 27):
```typescript
// Codespace
export const CODESPACE_HEALTH_CHECK_INTERVAL_MS = 30_000; // 30 seconds
export const CODESPACE_LIST_POLL_INTERVAL_MS = 60_000; // 60 seconds
export const SSH_TUNNEL_CONNECT_TIMEOUT_MS = 30_000; // 30 seconds
export const REMOTE_COMMAND_TIMEOUT_MS = 15_000; // 15 seconds
export const MAX_RECONNECT_ATTEMPTS = 5;
export const MAX_PORT_RETRIES = 3;
```

- [ ] **Step 2: Add codespace channels to `src/shared/ipc-channels.ts`**

Replace entire file content:
```typescript
export type IpcChannels =
  | "auth:start-login"
  | "auth:logout"
  | "auth:get-status"
  | "proxy:start"
  | "proxy:stop"
  | "proxy:get-status"
  | "token:get-info"
  | "config:get"
  | "models:get-available"
  | "models:get-selected"
  | "models:set-selected"
  | "settings:get-auto-start"
  | "settings:set-auto-start"
  | "codespace:check-gh-cli"
  | "codespace:list"
  | "codespace:connect"
  | "codespace:disconnect"
  | "codespace:disconnect-all"
  | "codespace:get-connections";

export type IpcEvents =
  | "auth:status-changed"
  | "proxy:status-changed"
  | "token:info-changed"
  | "proxy:request-log"
  | "codespace:status-changed"
  | "codespace:connection-error";
```

- [ ] **Step 3: Add `@codespace` path alias to `tsconfig.json`**

Add to the `paths` object in `tsconfig.json`:
```json
"@codespace/*": ["./src/codespace/*"]
```

- [ ] **Step 4: Add `src/codespace/` to vitest coverage and aliases**

In `vitest.config.ts`, add to `resolve.alias`:
```typescript
'@codespace': path.resolve(__dirname, 'src/codespace'),
```

Add to `test.coverage.include` array:
```typescript
'src/codespace/**/*.ts',
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors (all existing `satisfies IpcChannels` still work)

- [ ] **Step 6: Commit**

```bash
git add src/shared/constants.ts src/shared/ipc-channels.ts tsconfig.json vitest.config.ts
git commit -m "feat(codespace): add IPC channels, constants, and config updates"
```

---

## Task 3: gh CLI Wrapper

**Files:**
- Create: `src/codespace/__tests__/gh-cli.test.ts`
- Create: `src/codespace/gh-cli.ts`

- [ ] **Step 1: Write failing tests for gh CLI wrapper**

```typescript
// src/codespace/__tests__/gh-cli.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkGhCli, parseGhVersion, compareVersions } from "../gh-cli";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
const mockExecFile = vi.mocked(execFile);

// Helper to mock execFile callback
function mockExecFileResult(stdout: string, stderr = "", error: Error | null = null) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
    if (typeof _opts === "function") {
      callback = _opts;
    }
    callback(error, stdout, stderr);
    return {} as any;
  });
}

describe("parseGhVersion", () => {
  it("parses standard version string", () => {
    expect(parseGhVersion("gh version 2.45.0 (2024-03-01)")).toBe("2.45.0");
  });

  it("parses version without date", () => {
    expect(parseGhVersion("gh version 2.13.0")).toBe("2.13.0");
  });

  it("returns null for invalid input", () => {
    expect(parseGhVersion("not a version")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("2.13.0", "2.13.0")).toBe(0);
  });

  it("returns positive for greater version", () => {
    expect(compareVersions("2.14.0", "2.13.0")).toBeGreaterThan(0);
  });

  it("returns negative for lesser version", () => {
    expect(compareVersions("2.12.0", "2.13.0")).toBeLessThan(0);
  });

  it("handles major version difference", () => {
    expect(compareVersions("3.0.0", "2.99.99")).toBeGreaterThan(0);
  });
});

describe("checkGhCli", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("returns installed=false when gh is not found", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(new Error("ENOENT"), "", "");
      return {} as any;
    });

    const status = await checkGhCli();
    expect(status.installed).toBe(false);
    expect(status.meetsMinVersion).toBe(false);
  });

  it("returns version info when gh is installed", async () => {
    // First call: gh --version
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(null, "gh version 2.45.0 (2024-03-01)\n", "");
      return {} as any;
    });
    // Second call: gh auth status
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(null, "Logged in to github.com account user (keyring)\nToken scopes: codespace, read:user\n", "");
      return {} as any;
    });

    const status = await checkGhCli();
    expect(status.installed).toBe(true);
    expect(status.version).toBe("2.45.0");
    expect(status.meetsMinVersion).toBe(true);
    expect(status.authenticated).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/codespace/__tests__/gh-cli.test.ts`
Expected: FAIL — module `../gh-cli` not found

- [ ] **Step 3: Implement gh-cli.ts**

```typescript
// src/codespace/gh-cli.ts
import { execFile as execFileCb, spawn, type ChildProcess } from "node:child_process";
import { REMOTE_COMMAND_TIMEOUT_MS } from "../shared/constants";
import type { GhCliStatus, CodespaceInfo } from "./types";
import { MIN_GH_CLI_VERSION } from "./types";

function execFilePromise(
  cmd: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, { timeout: options?.timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function parseGhVersion(output: string): string | null {
  const match = output.match(/gh version (\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function checkGhCli(): Promise<GhCliStatus> {
  const result: GhCliStatus = {
    installed: false,
    meetsMinVersion: false,
    authenticated: false,
    hasCodespaceScope: false,
  };

  // Check gh version
  try {
    const { stdout } = await execFilePromise("gh", ["--version"]);
    const version = parseGhVersion(stdout);
    if (!version) return result;

    result.installed = true;
    result.version = version;
    result.meetsMinVersion = compareVersions(version, MIN_GH_CLI_VERSION) >= 0;
  } catch {
    return result;
  }

  // Check auth status
  try {
    const { stdout } = await execFilePromise("gh", ["auth", "status"]);
    result.authenticated = stdout.includes("Logged in");
    result.hasCodespaceScope = stdout.includes("codespace");
  } catch {
    // gh auth status exits non-zero when not logged in
    result.authenticated = false;
  }

  return result;
}

export async function listCodespaces(): Promise<CodespaceInfo[]> {
  const { stdout } = await execFilePromise("gh", [
    "api", "/user/codespaces",
    "--jq", ".codespaces",
  ], { timeout: REMOTE_COMMAND_TIMEOUT_MS });

  const raw = JSON.parse(stdout) as Array<{
    id: number;
    name: string;
    display_name?: string;
    state: string;
    repository: { full_name: string };
    machine?: { display_name?: string };
    last_used_at: string;
  }>;

  return raw.map((cs) => ({
    id: cs.id,
    name: cs.name,
    displayName: cs.display_name ?? cs.name,
    repository: cs.repository.full_name,
    state: cs.state,
    machine: cs.machine?.display_name ?? "unknown",
    lastUsedAt: cs.last_used_at,
  }));
}

export async function startCodespace(name: string): Promise<void> {
  await execFilePromise("gh", [
    "api", "-X", "POST", `/user/codespaces/${name}/start`,
  ], { timeout: REMOTE_COMMAND_TIMEOUT_MS });
}

export function spawnSshTunnel(
  codespaceName: string,
  remotePort: number,
  localPort: number,
): ChildProcess {
  return spawn("gh", [
    "codespace", "ssh",
    "--codespace", codespaceName,
    "--",
    `-R`, `${remotePort}:127.0.0.1:${localPort}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-N",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function executeRemoteCommand(
  codespaceName: string,
  command: string,
  timeoutMs = REMOTE_COMMAND_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await execFilePromise("gh", [
    "codespace", "ssh",
    "--codespace", codespaceName,
    "--", command,
  ], { timeout: timeoutMs });
  return stdout;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/codespace/__tests__/gh-cli.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/codespace/gh-cli.ts src/codespace/__tests__/gh-cli.test.ts
git commit -m "feat(codespace): add gh CLI wrapper with version detection"
```

---

## Task 4: Remote Config Script Generation

**Files:**
- Create: `src/codespace/__tests__/remote-config.test.ts`
- Create: `src/codespace/remote-config.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/codespace/__tests__/remote-config.test.ts
import { describe, it, expect } from "vitest";
import {
  buildWriteConfigScript,
  buildRemoveConfigScript,
  buildUpdateModelScript,
  buildWriteOnboardingScript,
} from "../remote-config";

describe("buildWriteConfigScript", () => {
  it("generates valid python3 script with port and model", () => {
    const script = buildWriteConfigScript(23337, "claude-sonnet-4-20250514");
    expect(script).toContain("python3 -c");
    expect(script).toContain("23337");
    expect(script).toContain("claude-sonnet-4-20250514");
    expect(script).toContain("ANTHROPIC_BASE_URL");
    expect(script).toContain("AGENT_MAESTRO_MANAGED");
  });

  it("escapes special characters in model name", () => {
    const script = buildWriteConfigScript(23337, "model-with'quotes");
    expect(script).not.toContain("'quotes");
    expect(script).toContain("model-with");
  });
});

describe("buildRemoveConfigScript", () => {
  it("generates valid python3 cleanup script", () => {
    const script = buildRemoveConfigScript();
    expect(script).toContain("python3 -c");
    expect(script).toContain("AGENT_MAESTRO_MANAGED");
    expect(script).toContain("pop");
  });
});

describe("buildUpdateModelScript", () => {
  it("generates python3 script that updates only model", () => {
    const script = buildUpdateModelScript("claude-opus-4-20250514");
    expect(script).toContain("python3 -c");
    expect(script).toContain("ANTHROPIC_MODEL");
    expect(script).toContain("claude-opus-4-20250514");
    expect(script).toContain("AGENT_MAESTRO_MANAGED");
  });
});

describe("buildWriteOnboardingScript", () => {
  it("generates python3 script for claude.json", () => {
    const script = buildWriteOnboardingScript();
    expect(script).toContain("python3 -c");
    expect(script).toContain("hasCompletedOnboarding");
    expect(script).toContain(".claude.json");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/codespace/__tests__/remote-config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement remote-config.ts**

```typescript
// src/codespace/remote-config.ts

/**
 * Escape a string for safe embedding in a Python string literal.
 * Removes single quotes and backslashes to prevent injection.
 */
function escapePythonString(value: string): string {
  return value.replace(/[\\']/g, "");
}

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/codespace/__tests__/remote-config.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/codespace/remote-config.ts src/codespace/__tests__/remote-config.test.ts
git commit -m "feat(codespace): add remote Claude config script generation"
```

---

## Task 5: SSH Tunnel Manager

**Files:**
- Create: `src/codespace/__tests__/ssh-tunnel.test.ts`
- Create: `src/codespace/ssh-tunnel.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/codespace/__tests__/ssh-tunnel.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SshTunnel } from "../ssh-tunnel";
import { EventEmitter } from "node:events";

// Mock gh-cli module
vi.mock("../gh-cli", () => ({
  spawnSshTunnel: vi.fn(),
}));

import { spawnSshTunnel } from "../gh-cli";
const mockSpawnSshTunnel = vi.mocked(spawnSshTunnel);

function createMockProcess(): EventEmitter & { kill: ReturnType<typeof vi.fn>; stderr: EventEmitter; stdout: EventEmitter; pid: number } {
  const proc = new EventEmitter() as any;
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

describe("SshTunnel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSpawnSshTunnel.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits connected after successful spawn", async () => {
    const mockProc = createMockProcess();
    mockSpawnSshTunnel.mockReturnValue(mockProc as any);

    const tunnel = new SshTunnel("my-codespace", 23337, 23337);
    const onState = vi.fn();
    tunnel.on("stateChanged", onState);

    const connectPromise = tunnel.connect();

    // Simulate SSH connecting (no early exit = connected)
    await vi.advanceTimersByTimeAsync(3000);
    // Mark as connected after timeout
    tunnel.markConnected();

    await connectPromise;

    expect(onState).toHaveBeenCalledWith("connected");
  });

  it("emits error when process exits unexpectedly", () => {
    const mockProc = createMockProcess();
    mockSpawnSshTunnel.mockReturnValue(mockProc as any);

    const tunnel = new SshTunnel("my-codespace", 23337, 23337);
    const onState = vi.fn();
    tunnel.on("stateChanged", onState);

    tunnel.connect();

    // Simulate process exit
    mockProc.emit("exit", 1, null);

    expect(onState).toHaveBeenCalledWith("error");
  });

  it("detects port conflict from stderr", () => {
    const mockProc = createMockProcess();
    mockSpawnSshTunnel.mockReturnValue(mockProc as any);

    const tunnel = new SshTunnel("my-codespace", 23337, 23337);
    const onPortConflict = vi.fn();
    tunnel.on("portConflict", onPortConflict);

    tunnel.connect();

    mockProc.stderr.emit("data", Buffer.from("bind: Address already in use"));

    expect(onPortConflict).toHaveBeenCalled();
  });

  it("stops and kills process on disconnect", () => {
    const mockProc = createMockProcess();
    mockSpawnSshTunnel.mockReturnValue(mockProc as any);

    const tunnel = new SshTunnel("my-codespace", 23337, 23337);
    tunnel.connect();

    tunnel.disconnect();

    expect(mockProc.kill).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/codespace/__tests__/ssh-tunnel.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ssh-tunnel.ts**

```typescript
// src/codespace/ssh-tunnel.ts
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { spawnSshTunnel } from "./gh-cli";
import { SSH_TUNNEL_CONNECT_TIMEOUT_MS } from "../shared/constants";
import type { CodespaceConnectionState } from "./types";

export class SshTunnel extends EventEmitter {
  private process: ChildProcess | null = null;
  private state: CodespaceConnectionState = "available";
  private intentionalDisconnect = false;

  constructor(
    public readonly codespaceName: string,
    public readonly remotePort: number,
    public readonly localPort: number,
  ) {
    super();
  }

  getState(): CodespaceConnectionState {
    return this.state;
  }

  connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.setState("connecting");

    this.process = spawnSshTunnel(this.codespaceName, this.remotePort, this.localPort);

    this.process.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString();
      console.log(`[SSHTunnel:${this.codespaceName}] stderr: ${msg.trim()}`);

      if (msg.includes("bind: Address already in use")) {
        this.emit("portConflict", this.remotePort);
      }
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      console.log(`[SSHTunnel:${this.codespaceName}] stdout: ${data.toString().trim()}`);
    });

    this.process.on("exit", (code, signal) => {
      console.log(`[SSHTunnel:${this.codespaceName}] exited code=${code} signal=${signal}`);
      this.process = null;

      if (!this.intentionalDisconnect) {
        this.setState("error");
        this.emit("unexpectedExit", code);
      }
    });

    this.process.on("error", (err) => {
      console.error(`[SSHTunnel:${this.codespaceName}] error:`, err.message);
      this.process = null;
      this.setState("error");
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // If process is still running after timeout, consider it connected
        if (this.process && !this.process.killed) {
          this.markConnected();
          resolve();
        } else {
          reject(new Error("SSH tunnel failed to establish"));
        }
      }, SSH_TUNNEL_CONNECT_TIMEOUT_MS);

      // If process exits before timeout, resolve/reject early
      const earlyExitHandler = () => {
        clearTimeout(timeout);
        reject(new Error("SSH tunnel process exited during connection"));
      };
      this.process?.once("exit", earlyExitHandler);

      // Allow manual marking as connected (clears timeout)
      this.once("_manualConnect", () => {
        clearTimeout(timeout);
        this.process?.removeListener("exit", earlyExitHandler);
        resolve();
      });
    });
  }

  markConnected(): void {
    this.setState("connected");
    this.emit("_manualConnect");
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.setState("available");
  }

  isConnected(): boolean {
    return this.state === "connected" && this.process !== null;
  }

  private setState(state: CodespaceConnectionState): void {
    this.state = state;
    this.emit("stateChanged", state);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/codespace/__tests__/ssh-tunnel.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/codespace/ssh-tunnel.ts src/codespace/__tests__/ssh-tunnel.test.ts
git commit -m "feat(codespace): add SSH tunnel process manager"
```

---

## Task 6: Codespace Manager (Orchestrator)

**Files:**
- Create: `src/codespace/__tests__/codespace-manager.test.ts`
- Create: `src/codespace/codespace-manager.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/codespace/__tests__/codespace-manager.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodespaceManager } from "../codespace-manager";

// Mock dependencies
vi.mock("../gh-cli", () => ({
  listCodespaces: vi.fn(),
  executeRemoteCommand: vi.fn(),
  spawnSshTunnel: vi.fn(),
}));

vi.mock("../ssh-tunnel", () => {
  const EventEmitter = require("node:events").EventEmitter;
  return {
    SshTunnel: vi.fn().mockImplementation(() => {
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      tunnel.codespaceName = "test-codespace";
      tunnel.remotePort = 23337;
      tunnel.localPort = 23337;
      return tunnel;
    }),
  };
});

import { listCodespaces, executeRemoteCommand } from "../gh-cli";

describe("CodespaceManager", () => {
  beforeEach(() => {
    vi.mocked(listCodespaces).mockReset();
    vi.mocked(executeRemoteCommand).mockReset();
  });

  it("allocates ports starting from base port", () => {
    const manager = new CodespaceManager(23337);
    const port1 = manager.allocatePort();
    const port2 = manager.allocatePort();
    expect(port1).toBe(23337);
    expect(port2).toBe(23338);
  });

  it("frees and reuses ports", () => {
    const manager = new CodespaceManager(23337);
    const port1 = manager.allocatePort();
    manager.freePort(port1);
    const port2 = manager.allocatePort();
    expect(port2).toBe(23337);
  });

  it("lists codespaces via gh CLI", async () => {
    vi.mocked(listCodespaces).mockResolvedValue([
      {
        id: 1,
        name: "test-cs",
        displayName: "test-cs",
        repository: "user/repo",
        state: "Available",
        machine: "4-core",
        lastUsedAt: "2026-03-24T10:00:00Z",
      },
    ]);

    const manager = new CodespaceManager(23337);
    const list = await manager.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("test-cs");
  });

  it("returns connections map", () => {
    const manager = new CodespaceManager(23337);
    const connections = manager.getConnections();
    expect(connections).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/codespace/__tests__/codespace-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement codespace-manager.ts**

```typescript
// src/codespace/codespace-manager.ts
import { EventEmitter } from "node:events";
import { SshTunnel } from "./ssh-tunnel";
import { listCodespaces as ghListCodespaces, executeRemoteCommand, startCodespace as ghStartCodespace } from "./gh-cli";
import {
  buildWriteConfigScript,
  buildWriteOnboardingScript,
  buildRemoveConfigScript,
  buildUpdateModelScript,
} from "./remote-config";
import { MAX_RECONNECT_ATTEMPTS, MAX_PORT_RETRIES, CODESPACE_HEALTH_CHECK_INTERVAL_MS } from "../shared/constants";
import type { CodespaceInfo, CodespaceConnection, CodespaceConnectionState } from "./types";

interface ConnectionEntry {
  readonly connection: CodespaceConnection;
  tunnel: SshTunnel;
  healthTimer: ReturnType<typeof setInterval> | null;
}

function updateConnection(
  conn: CodespaceConnection,
  patch: Partial<CodespaceConnection>,
): CodespaceConnection {
  return { ...conn, ...patch };
}

export class CodespaceManager extends EventEmitter {
  private connections = new Map<string, ConnectionEntry>();
  private allocatedPorts = new Set<number>();
  private basePort: number;

  constructor(basePort: number) {
    super();
    this.basePort = basePort;
  }

  allocatePort(): number {
    let port = this.basePort;
    while (this.allocatedPorts.has(port)) {
      port++;
    }
    this.allocatedPorts.add(port);
    return port;
  }

  freePort(port: number): void {
    this.allocatedPorts.delete(port);
  }

  async list(): Promise<CodespaceInfo[]> {
    return ghListCodespaces();
  }

  getConnections(): CodespaceConnection[] {
    return Array.from(this.connections.values()).map((e) => ({ ...e.connection }));
  }

  getConnection(name: string): CodespaceConnection | undefined {
    const entry = this.connections.get(name);
    return entry ? { ...entry.connection } : undefined;
  }

  /** Start a shutdown Codespace, then connect to it. */
  async startAndConnect(info: CodespaceInfo, model: string): Promise<CodespaceConnection> {
    await ghStartCodespace(info.name);
    // Wait a moment for the Codespace to become Available
    await new Promise((r) => setTimeout(r, 5000));
    const updatedInfo: CodespaceInfo = { ...info, state: "Available" };
    return this.connect(updatedInfo, model);
  }

  async connect(info: CodespaceInfo, model: string): Promise<CodespaceConnection> {
    if (this.connections.has(info.name)) {
      throw new Error(`Already connected to ${info.name}`);
    }

    const localPort = this.basePort;
    let remotePort = this.allocatePort();

    let connection: CodespaceConnection = {
      id: info.name,
      info,
      connectionState: "connecting",
      remotePort,
      localPort,
      connectedAt: null,
      lastHealthCheck: null,
      reconnectAttempts: 0,
    };

    this.emitConnection(connection);

    // Port conflict retry loop
    let tunnel: SshTunnel | null = null;
    let portRetries = 0;

    while (portRetries < MAX_PORT_RETRIES) {
      tunnel = new SshTunnel(info.name, remotePort, localPort);

      let portConflict = false;
      tunnel.on("portConflict", () => {
        portConflict = true;
      });

      try {
        await tunnel.connect();
        if (!portConflict) break;
      } catch {
        if (!portConflict) throw new Error("SSH tunnel failed to establish");
      }

      // Port conflict — try next port
      tunnel.disconnect();
      this.freePort(remotePort);
      remotePort = this.allocatePort();
      connection = updateConnection(connection, { remotePort });
      portRetries++;
    }

    if (!tunnel || !tunnel.isConnected()) {
      this.freePort(remotePort);
      connection = updateConnection(connection, {
        connectionState: "error",
        errorMessage: "Failed to find available port",
      });
      this.emitConnection(connection);
      throw new Error("Failed to find available port after retries");
    }

    // Configure remote Claude Code
    try {
      await executeRemoteCommand(info.name, buildWriteConfigScript(remotePort, model));
      await executeRemoteCommand(info.name, buildWriteOnboardingScript());
    } catch (err) {
      console.warn(`[CodespaceManager] Remote config write failed for ${info.name}:`, err);
      // Non-fatal — tunnel is still up
    }

    // Setup reconnect handler
    tunnel.on("unexpectedExit", () => {
      this.handleUnexpectedDisconnect(info.name, model);
    });

    // Start health check (app-level: curl /health through tunnel)
    const healthTimer = setInterval(() => {
      this.healthCheck(info.name);
    }, CODESPACE_HEALTH_CHECK_INTERVAL_MS);

    connection = updateConnection(connection, {
      connectionState: "connected",
      connectedAt: Date.now(),
    });

    this.connections.set(info.name, { connection, tunnel, healthTimer });
    this.emitConnection(connection);

    return { ...connection };
  }

  async disconnect(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) return;

    let connection = updateConnection(entry.connection, { connectionState: "disconnecting" });
    this.connections.set(name, { ...entry, connection });
    this.emitConnection(connection);

    // Stop health check
    if (entry.healthTimer) clearInterval(entry.healthTimer);

    // Clean remote config (best-effort)
    try {
      await executeRemoteCommand(name, buildRemoveConfigScript());
    } catch {
      console.warn(`[CodespaceManager] Remote config cleanup failed for ${name}`);
    }

    // Kill tunnel
    entry.tunnel.disconnect();
    this.freePort(connection.remotePort);

    connection = updateConnection(connection, { connectionState: "available" });
    this.connections.delete(name);
    this.emitConnection(connection);
  }

  async disconnectAll(): Promise<void> {
    const names = Array.from(this.connections.keys());
    await Promise.allSettled(names.map((name) => this.disconnect(name)));
  }

  /** Synchronous kill of all SSH processes. Used during app quit. */
  killAllTunnels(): void {
    for (const [, entry] of this.connections) {
      if (entry.healthTimer) clearInterval(entry.healthTimer);
      entry.tunnel.disconnect();
    }
    this.connections.clear();
    this.allocatedPorts.clear();
  }

  async updateModel(model: string): Promise<void> {
    const promises = Array.from(this.connections.entries()).map(async ([name]) => {
      try {
        await executeRemoteCommand(name, buildUpdateModelScript(model));
      } catch {
        console.warn(`[CodespaceManager] Model update failed for ${name}`);
      }
    });
    await Promise.allSettled(promises);
  }

  private async healthCheck(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry || entry.connection.connectionState !== "connected") return;

    try {
      await executeRemoteCommand(
        name,
        `curl -sf http://127.0.0.1:${entry.connection.remotePort}/health`,
      );
    } catch {
      console.warn(`[CodespaceManager] Health check failed for ${name}`);
      // Don't immediately error — SSH keepalive handles connection detection
    }

    const updated = updateConnection(entry.connection, { lastHealthCheck: Date.now() });
    this.connections.set(name, { ...entry, connection: updated });
  }

  private async handleUnexpectedDisconnect(name: string, model: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) return;

    if (entry.connection.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      const updated = updateConnection(entry.connection, {
        connectionState: "error",
        errorMessage: "Max reconnect attempts reached",
      });
      this.connections.set(name, { ...entry, connection: updated });
      this.emitConnection(updated);
      this.emit("connectionError", { name, message: updated.errorMessage });
      return;
    }

    let updated = updateConnection(entry.connection, {
      connectionState: "reconnecting",
      reconnectAttempts: entry.connection.reconnectAttempts + 1,
    });
    this.connections.set(name, { ...entry, connection: updated });
    this.emitConnection(updated);

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delay = Math.pow(2, updated.reconnectAttempts - 1) * 1000;
    await new Promise((r) => setTimeout(r, delay));

    try {
      // Free old port, allocate new
      this.freePort(updated.remotePort);
      const newPort = this.allocatePort();
      updated = updateConnection(updated, { remotePort: newPort });

      const tunnel = new SshTunnel(name, newPort, updated.localPort);
      await tunnel.connect();

      // Re-configure remote
      try {
        await executeRemoteCommand(name, buildWriteConfigScript(newPort, model));
      } catch {
        // Non-fatal
      }

      tunnel.on("unexpectedExit", () => {
        this.handleUnexpectedDisconnect(name, model);
      });

      updated = updateConnection(updated, {
        connectionState: "connected",
        reconnectAttempts: 0,
      });
      this.connections.set(name, { connection: updated, tunnel, healthTimer: entry.healthTimer });
      this.emitConnection(updated);
    } catch {
      updated = updateConnection(updated, {
        connectionState: "error",
        errorMessage: "Reconnection failed",
      });
      this.connections.set(name, { ...entry, connection: updated });
      this.emitConnection(updated);
      this.emit("connectionError", { name, message: "Reconnection failed" });
    }
  }

  private emitConnection(connection: CodespaceConnection): void {
    this.emit("connectionChanged", { ...connection });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/codespace/__tests__/codespace-manager.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run all tests to ensure nothing is broken**

Run: `npm test`
Expected: All existing + new tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/codespace/codespace-manager.ts src/codespace/__tests__/codespace-manager.test.ts
git commit -m "feat(codespace): add CodespaceManager orchestrator"
```

---

## Task 7: Preload Bridge Extension

**Files:**
- Modify: `src/preload.ts`

- [ ] **Step 1: Add codespace namespace to preload bridge**

Replace the entire file `src/preload.ts`:

```typescript
import { contextBridge, ipcRenderer } from "electron";
import type { IpcChannels } from "./shared/ipc-channels";

const api = {
  // Auth
  startLogin: () => ipcRenderer.invoke("auth:start-login" satisfies IpcChannels),
  logout: () => ipcRenderer.invoke("auth:logout" satisfies IpcChannels),
  getAuthStatus: () => ipcRenderer.invoke("auth:get-status" satisfies IpcChannels),

  // Proxy
  startProxy: () => ipcRenderer.invoke("proxy:start" satisfies IpcChannels),
  stopProxy: () => ipcRenderer.invoke("proxy:stop" satisfies IpcChannels),
  getProxyStatus: () => ipcRenderer.invoke("proxy:get-status" satisfies IpcChannels),

  // Token
  getTokenInfo: () => ipcRenderer.invoke("token:get-info" satisfies IpcChannels),

  // Config
  getConfig: () => ipcRenderer.invoke("config:get" satisfies IpcChannels),

  // Models
  getAvailableModels: () => ipcRenderer.invoke("models:get-available" satisfies IpcChannels),
  getSelectedModel: () => ipcRenderer.invoke("models:get-selected" satisfies IpcChannels),
  setSelectedModel: (modelId: string) => ipcRenderer.invoke("models:set-selected" satisfies IpcChannels, modelId),

  // Settings
  getAutoStart: () => ipcRenderer.invoke("settings:get-auto-start" satisfies IpcChannels),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke("settings:set-auto-start" satisfies IpcChannels, enabled),

  // Events from main process
  onAuthStatusChanged: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on("auth:status-changed", listener);
    return () => ipcRenderer.removeListener("auth:status-changed", listener);
  },
  onProxyStatusChanged: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on("proxy:status-changed", listener);
    return () => ipcRenderer.removeListener("proxy:status-changed", listener);
  },
  onTokenInfoChanged: (callback: (info: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: unknown) => callback(info);
    ipcRenderer.on("token:info-changed", listener);
    return () => ipcRenderer.removeListener("token:info-changed", listener);
  },
  onRequestLog: (callback: (log: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, log: unknown) => callback(log);
    ipcRenderer.on("proxy:request-log", listener);
    return () => ipcRenderer.removeListener("proxy:request-log", listener);
  },

  // Codespace
  codespace: {
    checkGhCli: () => ipcRenderer.invoke("codespace:check-gh-cli" satisfies IpcChannels),
    list: () => ipcRenderer.invoke("codespace:list" satisfies IpcChannels),
    connect: (name: string) => ipcRenderer.invoke("codespace:connect" satisfies IpcChannels, name),
    disconnect: (name: string) => ipcRenderer.invoke("codespace:disconnect" satisfies IpcChannels, name),
    disconnectAll: () => ipcRenderer.invoke("codespace:disconnect-all" satisfies IpcChannels),
    getConnections: () => ipcRenderer.invoke("codespace:get-connections" satisfies IpcChannels),
    onStatusChanged: (callback: (connection: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, connection: unknown) => callback(connection);
      ipcRenderer.on("codespace:status-changed", listener);
      return () => ipcRenderer.removeListener("codespace:status-changed", listener);
    },
    onError: (callback: (error: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, error: unknown) => callback(error);
      ipcRenderer.on("codespace:connection-error", listener);
      return () => ipcRenderer.removeListener("codespace:connection-error", listener);
    },
  },
};

export type CopilotBridgeAPI = typeof api;

contextBridge.exposeInMainWorld("copilotBridge", api);
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/preload.ts
git commit -m "feat(codespace): extend preload bridge with codespace API"
```

---

## Task 8: IPC Handlers Integration

**Files:**
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Add codespace IPC handlers**

Add the following imports at the top of `src/main/ipc-handlers.ts` (after line 9):
```typescript
import { CodespaceManager } from "../codespace/codespace-manager";
import { checkGhCli } from "../codespace/gh-cli";
import type { CodespaceConnection, CodespaceInfo, GhCliStatus } from "../codespace/types";
```

Add a new module-level variable after line 15:
```typescript
let codespaceManager: CodespaceManager | null = null;
```

Add a helper function after `getProxyStatus()` (after line 42):
```typescript
function getOrCreateCodespaceManager(): CodespaceManager {
  if (!codespaceManager) {
    const port = proxyServer?.getPort() ?? getProxyPort();
    codespaceManager = new CodespaceManager(port);

    codespaceManager.on("connectionChanged", (connection: CodespaceConnection) => {
      sendToRenderer("codespace:status-changed", connection);
    });

    codespaceManager.on("connectionError", (error: { name: string; message: string }) => {
      sendToRenderer("codespace:connection-error", error);
    });
  }
  return codespaceManager;
}
```

Add codespace handlers inside `registerIpcHandlers()` (before the closing `}` at line 313):
```typescript
  // --- Codespace handlers ---

  ipcMain.handle("codespace:check-gh-cli" satisfies IpcChannels, async (): Promise<GhCliStatus> => {
    return checkGhCli();
  });

  ipcMain.handle("codespace:list" satisfies IpcChannels, async (): Promise<CodespaceInfo[]> => {
    const manager = getOrCreateCodespaceManager();
    return manager.list();
  });

  ipcMain.handle("codespace:connect" satisfies IpcChannels, async (_event, name: string): Promise<CodespaceConnection> => {
    // Ensure proxy is running before connecting
    await ensureProxyRunning();

    const manager = getOrCreateCodespaceManager();
    const codespaces = await manager.list();
    const info = codespaces.find((cs) => cs.name === name);
    if (!info) {
      throw new Error(`Codespace "${name}" not found`);
    }
    const model = getSelectedModel() ?? "";

    // If Codespace is Shutdown, start it first
    if (info.state === "Shutdown") {
      return manager.startAndConnect(info, model);
    }

    return manager.connect(info, model);
  });

  ipcMain.handle("codespace:disconnect" satisfies IpcChannels, async (_event, name: string): Promise<void> => {
    const manager = getOrCreateCodespaceManager();
    await manager.disconnect(name);
  });

  ipcMain.handle("codespace:disconnect-all" satisfies IpcChannels, async (): Promise<void> => {
    const manager = getOrCreateCodespaceManager();
    await manager.disconnectAll();
  });

  ipcMain.handle("codespace:get-connections" satisfies IpcChannels, (): CodespaceConnection[] => {
    const manager = getOrCreateCodespaceManager();
    return manager.getConnections();
  });
```

Modify the existing `models:set-selected` handler (around line 288) to also propagate model changes to Codespaces. Replace:
```typescript
  ipcMain.handle("models:set-selected" satisfies IpcChannels, async (_event, modelId: string) => {
    setSelectedModel(modelId);
    // Write model to Claude config
    try {
      await writeModelToClaudeConfig(modelId);
      console.log(`[IPC] Model set to: ${modelId}`);
    } catch (error) {
      console.error("[IPC] Failed to write model to Claude config:", error);
    }
    return modelId;
  });
```

With:
```typescript
  ipcMain.handle("models:set-selected" satisfies IpcChannels, async (_event, modelId: string) => {
    setSelectedModel(modelId);
    // Write model to local Claude config
    try {
      await writeModelToClaudeConfig(modelId);
      console.log(`[IPC] Model set to: ${modelId}`);
    } catch (error) {
      console.error("[IPC] Failed to write model to Claude config:", error);
    }
    // Propagate to connected Codespaces
    if (codespaceManager) {
      codespaceManager.updateModel(modelId).catch((err) => {
        console.error("[IPC] Failed to update model in Codespaces:", err);
      });
    }
    return modelId;
  });
```

Update the `cleanup()` function to also clean up codespace connections synchronously (kill SSH processes immediately):
```typescript
export function cleanup(): void {
  // Kill all SSH tunnel processes synchronously (best-effort)
  if (codespaceManager) {
    codespaceManager.killAllTunnels();
    codespaceManager = null;
  }
  tokenManager?.dispose();
  if (proxyServer?.isRunning()) {
    proxyServer.stop();
  }
}
```

Note: `killAllTunnels()` is a synchronous method on CodespaceManager that calls `process.kill()` on each SSH child process without waiting for remote config cleanup. This is appropriate for app-quit since async cleanup cannot complete in Electron's `before-quit` handler.

- [ ] **Step 2: Add `killAllTunnels()` to CodespaceManager**

In `src/codespace/codespace-manager.ts`, add this method:
```typescript
  /** Synchronous kill of all SSH processes. Used during app quit. */
  killAllTunnels(): void {
    for (const [, entry] of this.connections) {
      if (entry.healthTimer) clearInterval(entry.healthTimer);
      entry.tunnel.disconnect();
    }
    this.connections.clear();
    this.allocatedPorts.clear();
  }
```

- [ ] **Step 3: No changes needed to `src/main/index.ts`**

The existing `before-quit` handler (line 161) calls `cleanup()` synchronously — this is correct. The `cleanup()` function remains synchronous. No change needed.

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/index.ts
git commit -m "feat(codespace): register IPC handlers and integrate cleanup"
```

---

## Task 9: CodespacePanel React Component

**Files:**
- Create: `src/renderer/components/CodespacePanel.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Create CodespacePanel component**

```tsx
// src/renderer/components/CodespacePanel.tsx
import React, { useState, useEffect, useCallback, useRef } from "react";
import type { CodespaceConnection, CodespaceInfo, GhCliStatus } from "../../codespace/types";
import { KNOWN_CODESPACE_STATES } from "../../codespace/types";

const api = window.copilotBridge;

const POLL_INTERVAL_MS = 60_000; // 60 seconds

interface Props {
  authenticated: boolean;
}

type DisplayItem = {
  info: CodespaceInfo;
  connection?: CodespaceConnection;
};

function stateIcon(state: string | undefined): string {
  switch (state) {
    case "connected": return "🟢";
    case "connecting":
    case "disconnecting":
    case "reconnecting": return "🟡";
    case "error": return "🔴";
    default: return "⚪";
  }
}

function formatUptime(connectedAt: number | null): string {
  if (!connectedAt) return "";
  const seconds = Math.floor((Date.now() - connectedAt) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function CodespacePanel({ authenticated }: Props) {
  const [ghStatus, setGhStatus] = useState<GhCliStatus | null>(null);
  const [codespaces, setCodespaces] = useState<CodespaceInfo[]>([]);
  const [connections, setConnections] = useState<CodespaceConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true);
    setError(null);
    try {
      const [status, list, conns] = await Promise.all([
        api.codespace.checkGhCli(),
        api.codespace.list().catch(() => [] as CodespaceInfo[]),
        api.codespace.getConnections(),
      ]);
      setGhStatus(status as GhCliStatus);
      setCodespaces(list as CodespaceInfo[]);
      setConnections(conns as CodespaceConnection[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [authenticated]);

  // Initial load + auto-refresh polling (pause when hidden)
  useEffect(() => {
    refresh();

    const startPolling = () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        refresh();
        startPolling();
      }
    };

    startPolling();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  // Listen for status changes
  useEffect(() => {
    const unsubStatus = api.codespace.onStatusChanged((conn) => {
      const c = conn as CodespaceConnection;
      setConnections((prev) => {
        const existing = prev.findIndex((p) => p.id === c.id);
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = c;
          return next;
        }
        if (c.connectionState !== "available") {
          return [...prev, c];
        }
        return prev.filter((p) => p.id !== c.id);
      });
    });

    const unsubError = api.codespace.onError((err) => {
      const e = err as { name: string; message: string };
      setError(`${e.name}: ${e.message}`);
    });

    return () => {
      unsubStatus();
      unsubError();
    };
  }, []);

  const handleConnect = useCallback(async (name: string) => {
    try {
      setError(null);
      await api.codespace.connect(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleDisconnect = useCallback(async (name: string) => {
    try {
      setError(null);
      await api.codespace.disconnect(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  if (!authenticated) return null;

  // Merge codespaces with connections
  const items: DisplayItem[] = codespaces
    .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
    .map((info) => ({
      info,
      connection: connections.find((c) => c.id === info.name),
    }));

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700 col-span-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Codespaces</h2>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-sm px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {/* gh CLI status */}
      {ghStatus && (
        <div className="text-sm mb-3 text-gray-400">
          gh CLI:{" "}
          {ghStatus.installed ? (
            <span className="text-green-400">
              v{ghStatus.version}
              {!ghStatus.meetsMinVersion && " (needs >= 2.13.0)"}
              {!ghStatus.authenticated && " | Not authenticated"}
              {ghStatus.authenticated && !ghStatus.hasCodespaceScope && " | Missing codespace scope"}
            </span>
          ) : (
            <span className="text-red-400">
              Not installed —{" "}
              <a href="https://cli.github.com" className="underline text-blue-400" target="_blank" rel="noreferrer">
                Install gh CLI
              </a>
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="text-sm text-red-400 mb-3 bg-red-900/20 p-2 rounded">
          {error}
        </div>
      )}

      {/* Codespace list */}
      {items.length === 0 && !loading && (
        <p className="text-sm text-gray-500">No Codespaces found</p>
      )}

      <div className="space-y-2">
        {items.map((item) => {
          const connState = item.connection?.connectionState;
          const isConnected = connState === "connected";
          const isInProgress = connState === "connecting" || connState === "disconnecting" || connState === "reconnecting";
          const isError = connState === "error";
          const isAvailable = item.info.state === KNOWN_CODESPACE_STATES.AVAILABLE;
          const isShutdown = item.info.state === KNOWN_CODESPACE_STATES.SHUTDOWN;
          const isOtherState = !isAvailable && !isShutdown && !connState;

          return (
            <div key={item.info.name} className={`bg-gray-700/50 rounded p-3 ${isOtherState ? "opacity-50" : ""}`}>
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span>{stateIcon(connState)}</span>
                    <span className="font-mono text-sm truncate">{item.info.displayName}</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-1 ml-6">
                    {item.info.repository}
                    {isConnected && item.connection?.connectedAt && (
                      <span className="ml-2">
                        | port: {item.connection.remotePort} → {item.connection.localPort}
                        | uptime: {formatUptime(item.connection.connectedAt)}
                      </span>
                    )}
                    {isError && item.connection?.errorMessage && (
                      <span className="text-red-400 ml-2">| {item.connection.errorMessage}</span>
                    )}
                    {!connState && !isAvailable && (
                      <span className="ml-2">| {item.info.state}</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 ml-3">
                  {isConnected && (
                    <button
                      onClick={() => handleDisconnect(item.info.name)}
                      className="text-xs px-3 py-1 bg-red-600 hover:bg-red-500 rounded transition-colors"
                    >
                      Disconnect
                    </button>
                  )}
                  {isError && (
                    <>
                      <button
                        onClick={() => handleConnect(item.info.name)}
                        className="text-xs px-3 py-1 bg-yellow-600 hover:bg-yellow-500 rounded transition-colors"
                      >
                        Reconnect
                      </button>
                      <button
                        onClick={() => setConnections((prev) => prev.filter((c) => c.id !== item.info.name))}
                        className="text-xs px-3 py-1 bg-gray-600 hover:bg-gray-500 rounded transition-colors"
                      >
                        Dismiss
                      </button>
                    </>
                  )}
                  {!connState && isAvailable && (
                    <button
                      onClick={() => handleConnect(item.info.name)}
                      className="text-xs px-3 py-1 bg-green-600 hover:bg-green-500 rounded transition-colors"
                    >
                      Connect
                    </button>
                  )}
                  {!connState && isShutdown && (
                    <button
                      onClick={() => handleConnect(item.info.name)}
                      className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded transition-colors"
                    >
                      Start & Connect
                    </button>
                  )}
                  {isInProgress && (
                    <span className="text-xs text-yellow-400 px-3 py-1">
                      {connState === "connecting" ? "Connecting..." : connState === "disconnecting" ? "Disconnecting..." : "Reconnecting..."}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add CodespacePanel to App.tsx layout**

In `src/renderer/App.tsx`, add the import after line 7:
```typescript
import CodespacePanel from "./components/CodespacePanel";
```

Add the panel in the JSX after the ModelSelector/SettingsPanel grid (after line 103):
```tsx
        <CodespacePanel authenticated={authStatus.authenticated} />
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/CodespacePanel.tsx src/renderer/App.tsx
git commit -m "feat(codespace): add CodespacePanel UI component"
```

---

## Task 10: Integration Test & Final Verification

**Files:**
- All files from previous tasks

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS (existing + new)

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run the app in dev mode**

Run: `npm run dev`
Expected: App starts, CodespacePanel visible when authenticated. gh CLI status shows.

- [ ] **Step 4: Verify existing functionality is not broken**

Checklist:
- [ ] Login still works (OAuth device flow)
- [ ] Proxy starts and shows running status
- [ ] Model selector loads and switches models
- [ ] Request log shows entries
- [ ] Logout cleans up properly

- [ ] **Step 5: Verify no untracked files**

Run: `git status`
Expected: All changes from Tasks 1-9 are committed. No unintended files.
