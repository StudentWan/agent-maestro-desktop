<!-- Generated: 2026-03-24 | Files scanned: 75 | Token estimate: ~900 -->

# Architecture

## System Diagram

```
┌────────────────── Electron Main Process ──────────────────┐
│                                                            │
│  index.ts → registerIpcHandlers() → createWindow()        │
│       │                                                    │
│  ┌────┴────────────────────────────────────────────────┐   │
│  │ IPC Handlers (ipc-handlers.ts, 397 lines)           │   │
│  │ ├── auth:*      → OAuth Device Flow → TokenManager  │   │
│  │ ├── proxy:*     → ProxyServer (Hono)                │   │
│  │ ├── models:*    → Copilot API + claude-config.ts    │   │
│  │ ├── settings:*  → electron-store                    │   │
│  │ └── codespace:* → CodespaceManager → SSH tunnels    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ProxyServer (127.0.0.1:23337)                       │   │
│  │ POST /v1/messages  → convert → CopilotClient → back│   │
│  │ GET  /v1/models    → fetch from Copilot             │   │
│  │ POST /v1/count_tokens → estimate                    │   │
│  │ GET  /health       → OK                             │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
       │ IPC (contextBridge)
       ▼
┌────────────────── Electron Renderer ──────────────────────┐
│  App.tsx                                                   │
│  ├── AuthPanel        (login/logout)                       │
│  ├── ProxyPanel       (start/stop)                         │
│  ├── ModelSelector    (dropdown)                           │
│  ├── SettingsPanel    (auto-start)                         │
│  ├── CodespacePanel   (SSH tunnel management)              │
│  ├── ConfigPanel      (env vars display)                   │
│  ├── RequestLog       (paginated table)                    │
│  └── StatusBar        (footer)                             │
└────────────────────────────────────────────────────────────┘
       │ HTTPS
       ▼
┌──────────────────── External Services ────────────────────┐
│  GitHub OAuth    → api.github.com/login/device/code       │
│  Copilot Token   → api.github.com/copilot_internal/v2     │
│  Copilot Chat    → api.githubcopilot.com/chat/completions │
│  Codespace API   → gh api /user/codespaces (via gh CLI)   │
│  Codespace SSH   → gh codespace ssh (SSH reverse tunnel)  │
└───────────────────────────────────────────────────────────┘
```

## Module Boundaries

| Module | Responsibility | Key Files |
|--------|---------------|-----------|
| `main/` | Electron lifecycle, IPC, config | index.ts, ipc-handlers.ts, claude-config.ts |
| `renderer/` | React UI, 10 components | App.tsx + 9 components |
| `proxy/` | HTTP server, 4 routes | server.ts, routes/*.ts |
| `copilot/` | GitHub auth, Copilot API client | auth.ts, client.ts, token-manager.ts |
| `converter/` | Anthropic ↔ OpenAI format translation | anthropic-to-openai.ts, stream-transformer.ts |
| `codespace/` | SSH tunnel to GitHub Codespaces | codespace-manager.ts, ssh-tunnel.ts, gh-cli.ts |
| `shared/` | Types, constants, IPC channel defs | types.ts, constants.ts, ipc-channels.ts |
| `store/` | Persistent config (electron-store) | app-store.ts |

## Data Flow

```
Claude Code → POST /v1/messages (Anthropic format)
  → convertAnthropicToOpenAI() → mapModelName()
  → CopilotClient.chatCompletion[Stream]()
  → Copilot API (OpenAI format)
  → convertOpenAIToAnthropic() / createStreamTransformer()
  → Response (Anthropic format) → Claude Code
```

## Codespace Tunnel Flow

```
Codespace Claude Code → localhost:23337
  → SSH reverse tunnel (-R 23337:127.0.0.1:23337)
  → Local ProxyServer → Copilot API → back through tunnel
```

## Stats

- **Total**: ~6,500 lines across 75 files
- **Tests**: 24 files, 151 tests, ~1,400 lines
- **IPC**: 20 invoke channels + 6 event channels
- **Dependencies**: 9 runtime, 11 dev
