<!-- Generated: 2026-03-24 | Files scanned: 8 | Token estimate: ~400 -->

# Dependencies

## External Services

| Service | Purpose | URL |
|---------|---------|-----|
| GitHub OAuth | Device Flow authentication | github.com/login/device/code |
| GitHub API | User info, Codespace management | api.github.com |
| Copilot Token | JWT for Copilot API access | api.github.com/copilot_internal/v2/token |
| Copilot Chat | Claude model inference | api.githubcopilot.com/chat/completions |

## External Tools (User-installed)

| Tool | Purpose | Min Version |
|------|---------|-------------|
| `gh` CLI | SSH tunnel to Codespaces, API calls | >= 2.13.0 |

## Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| electron | ^34.0.0 | Desktop app framework |
| react / react-dom | ^19.0.0 | UI rendering |
| hono | ^4.6.0 | HTTP proxy server framework |
| @hono/node-server | ^1.13.0 | Node.js HTTP adapter for Hono |
| electron-store | ^10.0.0 | Persistent config (githubToken, port, model) |
| eventsource-parser | ^3.0.0 | SSE stream parsing |
| uuid | ^11.0.0 | Request ID generation |

## Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| typescript | ^5.7.0 | Type checking |
| vite | ^6.0.0 | Build tooling |
| vitest | ^4.1.0 | Test runner |
| @vitest/coverage-v8 | ^4.1.0 | Coverage reporting |
| tailwindcss | ^3.4.17 | CSS framework |
| @electron-forge/* | ^7.6.0 | Packaging & distribution |
| @vitejs/plugin-react | ^4.3.0 | React HMR for Vite |

## Local File Dependencies

| File | Written By | Read By |
|------|-----------|---------|
| `~/.claude/settings.json` | claude-config.ts, remote-config.ts | Claude Code CLI |
| `~/.claude.json` | claude-config.ts, remote-config.ts | Claude Code CLI |
| Electron Store (OS-specific) | app-store.ts | app-store.ts |

## Shared Libraries (Internal)

| Module | Used By |
|--------|---------|
| `shared/types.ts` | All modules (IPC data shapes) |
| `shared/constants.ts` | copilot, proxy, codespace |
| `shared/ipc-channels.ts` | preload.ts, ipc-handlers.ts |
| `codespace/types.ts` | codespace/*, renderer/CodespacePanel |
| `converter/types.ts` | converter/*, proxy/routes |
| `copilot/types.ts` | copilot/*, proxy/routes |
