<!-- Generated: 2026-03-24 | Files scanned: 2 | Token estimate: ~250 -->

# Data (Persistent Storage)

## Electron Store Schema

```typescript
// Stored in OS-specific location (encrypted at rest on macOS/Windows)
interface StoreSchema {
  githubToken: string | null;       // GitHub OAuth access token
  proxyPort: number;                // Default: 23337
  autoStart: boolean;               // Default: true
  minimizeToTray: boolean;          // Default: true
  selectedModel: string | null;     // e.g. "claude-sonnet-4-20250514"
}
```

**File**: `src/store/app-store.ts` (51 lines)
**Library**: electron-store ^10.0.0

## Claude Code Config Files (Written to Filesystem)

### `~/.claude/settings.json`
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:23337",
    "ANTHROPIC_AUTH_TOKEN": "Powered by Agent Maestro Desktop",
    "ANTHROPIC_MODEL": "claude-sonnet-4-20250514",
    "AGENT_MAESTRO_MANAGED": "true"
  }
}
```
- Written by: `claude-config.ts` (local), `remote-config.ts` (Codespace)
- Removed on logout/disconnect (only our values, merge-safe)

### `~/.claude.json`
```json
{
  "hasCompletedOnboarding": true
}
```
- Written once to bypass Claude Code onboarding prompt

## In-Memory State (Not Persisted)

| State | Location | Lifetime |
|-------|----------|----------|
| Copilot JWT token | TokenManager | 30min (auto-refreshed at 25min) |
| SSH tunnel processes | CodespaceManager | App session |
| Request log entries | App.tsx state | App session (max 200) |
| Codespace connections | CodespaceManager | App session |
