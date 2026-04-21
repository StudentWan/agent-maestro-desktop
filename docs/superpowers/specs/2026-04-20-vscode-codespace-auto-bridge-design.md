# VS Code Codespace Auto-Bridge — Design

**Date:** 2026-04-20
**Status:** approved (user instructed: "实现功能即可")
**Goal:** When the user opens a Codespace from VS Code on this machine, automatically inject the local proxy into that Codespace's Claude Code without requiring manual UI action.

## Background

Today users must open the Codespace panel and click **Connect** for each Codespace. The new flow detects VS Code's existing Codespace SSH sessions and bridges them silently.

Assumption (per user): on a given machine the only client opening Codespace SSH sessions is VS Code; manual `Connect` and the auto-bridge will not collide.

## Architecture

Three new units, all wired into the existing `CodespaceManager`:

```
VsCodeCodespaceDetector ─changed(set)─▶ AutoBridgeOrchestrator ─connect/disconnect─▶ CodespaceManager
        │                                       │
        ▼                                       ▼
   listProcesses()                        grace-period timer
```

### 1. `src/codespace/process-list.ts`

Cross-platform process enumerator. One exported function:

```ts
export interface ProcessInfo { pid: number; command: string; }
export async function listProcesses(): Promise<ProcessInfo[]>;
```

Implementation:
- **Windows**: spawn `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`, parse JSON.
- **macOS / Linux**: spawn `ps -A -o pid=,command=`, split lines, parse leading PID then rest as command.

A platform parameter `(platform: NodeJS.Platform)` lets tests inject `"win32"` or `"darwin"` deterministically. The actual command output is also injectable via a `runner` argument so tests run with no real shell.

### 2. `src/codespace/vscode-detector.ts`

```ts
export interface VsCodeCodespaceDetectorOptions {
  intervalMs?: number;                              // default 10_000
  listProcesses?: () => Promise<ProcessInfo[]>;     // injectable
  listCodespaces?: () => Promise<CodespaceInfo[]>;  // injectable, cached internally
  codespaceListCacheMs?: number;                    // default 30_000
}

export class VsCodeCodespaceDetector extends EventEmitter {
  start(): void;
  stop(): void;
  getCurrent(): ReadonlyMap<string, CodespaceInfo>;
  // emits "changed" with current Map
}
```

Detection passes:
1. Run `listProcesses()`.
2. For each process command, try regex extractors in order; collect raw candidate names:
   - `/--codespace[= ]([A-Za-z0-9_-]+)/` (matches `gh codespace ssh --codespace foo`)
   - `/-c\s+([A-Za-z0-9_-]+)/` adjacent to `gh` + `codespace`/`cs` + `ssh` tokens
   - `/([A-Za-z0-9_-]{8,})@(?:[a-z0-9-]+\.)?ssh\.codespaces\.dev/` (VS Code Remote-SSH host pattern)
   - `/codespaces.*?[\s"=]([A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,}-[A-Za-z0-9]{4,})/` (hex/word-token codespace name embedded in vscode-remote args)
3. Intersect candidate names with `listCodespaces()` (cached). Only matches survive.
4. Diff against the previous emitted set; if changed, emit `"changed"` with `Map<name, CodespaceInfo>`.

Errors from `listProcesses` / `listCodespaces` are swallowed (logged) — detection just stays at last known state until next tick.

### 3. `src/codespace/auto-bridge.ts`

```ts
export interface AutoBridgeOrchestratorOptions {
  graceMs?: number;            // default 120_000 (2 min)
  getModel: () => string;
}

export class AutoBridgeOrchestrator {
  constructor(
    detector: VsCodeCodespaceDetector,
    manager: CodespaceManager,
    opts: AutoBridgeOrchestratorOptions,
  );
  start(): void;   // attaches to detector "changed"
  stop(): void;
  // for tests:
  getPendingDisconnects(): ReadonlyMap<string, NodeJS.Timeout>;
}
```

Reaction to `changed(currentSet)`:
- For names in `currentSet` not in `manager.getConnections()`: call `manager.connect(info, model)` with `source="vscode-auto"`. Cancel any pending disconnect timer for that name.
- For currently-bridged `vscode-auto` connections whose name disappeared from `currentSet`: schedule a disconnect after `graceMs`. If the name reappears before the timer fires, cancel.
- Connections with `source="manual"` are ignored entirely.

Errors from `manager.connect` are logged; orchestrator does not retry (the manager has its own reconnect path). On next detector tick the missing connection is detected again and retried.

### 4. Manager / type changes

- `CodespaceConnection` gains `source: "manual" | "vscode-auto"` (default `"manual"` for back-compat).
- `CodespaceManager.connect(info, model, source = "manual")` — store source in the connection record, propagate in `connectionChanged` events.
- No other manager changes; existing reconnect, health check, port allocation all reused.

### 5. IPC / UI surface

Tiny additions:
- IPC events `codespace:auto-bridge-status` already covered by reusing existing `codespace:status-changed`.
- Add a small badge in `CodespacePanel.tsx`: when `connection.source === "vscode-auto"`, render `🔗 auto` next to the name.
- No new IPC handlers required for v1. (Future settings toggle can be added later.)

### 6. Wiring (in `ipc-handlers.ts`)

After the proxy is started and CodespaceManager is created, instantiate detector + orchestrator and `start()` both. On `cleanup()`, `stop()` both before killing tunnels.

## Constants (added to `shared/constants.ts`)

```ts
export const VSCODE_DETECTOR_POLL_INTERVAL_MS = 10_000;
export const VSCODE_AUTO_BRIDGE_GRACE_MS = 120_000;
export const CODESPACE_LIST_CACHE_MS = 30_000;
```

## Error handling

| Failure | Handling |
|---|---|
| `listProcesses` errors (permission, ENOENT) | Log once; detector keeps polling. UI unaffected. |
| `gh cs list` errors | Same — return cached value if any; otherwise empty. |
| `manager.connect` throws | Log; orchestrator clears the "in-progress" mark so next tick can retry. |
| VS Code disappears momentarily then reappears within grace | No reconnect work — timer canceled. |
| User signed out (no token) | Detector keeps running but `gh cs list` may fail; that drops candidates to empty, so nothing bridges. |

## Testing

Vitest unit tests (no real processes / no real SSH):

- `process-list.test.ts`: parse PowerShell JSON output (Win) and `ps` output (Unix); empty / malformed input.
- `vscode-detector.test.ts`:
  - matches `gh codespace ssh --codespace foo` → `foo`
  - matches `ssh foo@ssh.codespaces.dev` → `foo`
  - rejects names not in `listCodespaces()`
  - emits `"changed"` only on diff (with fake clock advancing)
  - cache for `gh cs list` honored within window
- `auto-bridge.test.ts`:
  - new name in set → manager.connect called with `source="vscode-auto"`
  - name leaves set → after `graceMs` manager.disconnect called
  - name leaves then returns within grace → no disconnect call
  - name with `source="manual"` already connected → orchestrator does nothing
- `codespace-manager.test.ts`: extend to verify `source` propagation on `connect()`.

## Build / acceptance

- `npm run test` green.
- `npm run package` succeeds (electron-forge package — full `make` requires admin on Windows squirrel; package is sufficient for build verification).
- Visual: with VS Code attached to a Codespace, on next 10 s tick the CodespacePanel shows that Codespace transitioning to `🟢 connected` with a `🔗 auto` badge, and `~/.claude/settings.json` inside that Codespace contains the proxy env vars.

## Out of scope

- Multiple machines collaborating.
- Detecting browser-based vscode.dev sessions (no local processes to observe).
- Settings toggle to disable the feature (hard-coded on for v1).
