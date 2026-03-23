---
name: agent-maestro-architecture
description: Architecture reference for Agent Maestro Desktop — an Electron + React proxy app that bridges Anthropic Claude API with GitHub Copilot infrastructure. Read this FIRST before analyzing, understanding, or optimizing any part of the codebase.
version: 1.0.0
source: local-repo-analysis
analyzed_commits: 7
---

# Agent Maestro Desktop — Architecture Reference

## What This App Does

A desktop application (Electron) that runs a **local proxy server** on `127.0.0.1:23337`. It authenticates users via **GitHub Copilot** OAuth, then translates **Anthropic Messages API** requests into **OpenAI-compatible Copilot API** calls and streams responses back in Anthropic format. This lets Claude Code, VS Code extensions, and CLI tools use Claude models through GitHub's Copilot infrastructure transparently.

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop shell | Electron | 34.x |
| UI framework | React | 19.x |
| Language | TypeScript (strict) | 5.7 |
| Build tool | Vite | 6.x |
| Proxy server | Hono + @hono/node-server | 4.6 |
| Persistent storage | electron-store | 10.x |
| Styling | Tailwind CSS | 3.4 |
| Test framework | Vitest | 4.1 |
| Packaging | Electron Forge | 7.6 |

## Directory Map

```
src/
├── main/                          # Electron main process
│   ├── index.ts                   # App lifecycle, window creation, tray
│   ├── ipc-handlers.ts            # ALL IPC request handlers (auth, proxy, config, models, settings)
│   ├── claude-config.ts           # Read/write ~/.claude/settings.json
│   └── tray.ts                    # System tray icon & menu
│
├── preload.ts                     # Context bridge — exposes `window.copilotBridge` API
│
├── renderer/                      # React UI (Vite-bundled)
│   ├── index.tsx                  # React root mount
│   ├── App.tsx                    # Root component — manages auth/proxy/log state
│   └── components/
│       ├── AuthPanel.tsx          # Login/logout with device code display
│       ├── ProxyPanel.tsx         # Start/stop proxy, port, request count
│       ├── ModelSelector.tsx      # Claude model picker dropdown
│       ├── SettingsPanel.tsx      # Auto-start toggle
│       ├── RequestLog.tsx         # Paginated request history (20/page, max 200)
│       ├── ConfigPanel.tsx        # Show proxy configuration
│       ├── StatusBar.tsx          # Footer status indicator
│       └── TokenCountdown.tsx     # JWT token expiry countdown
│
├── copilot/                       # GitHub Copilot integration
│   ├── auth.ts                    # GitHub OAuth device flow
│   ├── token-manager.ts           # JWT lifecycle (fetch, cache, auto-refresh 25min)
│   ├── client.ts                  # HTTP client for Copilot Chat API
│   ├── headers.ts                 # Build Copilot-compatible HTTP headers
│   ├── models.ts                  # Fetch available Claude models from Copilot
│   ├── types.ts                   # Copilot API type definitions
│   └── __tests__/                 # Unit tests
│
├── converter/                     # API format translation (core logic)
│   ├── anthropic-to-openai.ts     # Anthropic request → OpenAI/Copilot request
│   ├── openai-to-anthropic.ts     # OpenAI/Copilot response → Anthropic response
│   ├── model-mapper.ts            # Model ID translation (e.g. claude-sonnet-4-6 → claude-sonnet-4.6)
│   ├── tool-converter.ts          # Tool/function definition conversion
│   ├── stream-transformer.ts      # SSE event format translation (streaming)
│   ├── types.ts                   # Anthropic/OpenAI type definitions
│   └── __tests__/                 # Unit tests (heaviest test coverage)
│
├── proxy/                         # Hono HTTP proxy server
│   ├── server.ts                  # ProxyServer class — Hono app setup, start/stop
│   ├── middleware/
│   │   └── request-logger.ts      # Captures method, path, model, status, duration, tokens
│   ├── routes/
│   │   ├── anthropic-messages.ts  # POST /v1/messages — main proxy route
│   │   ├── anthropic-count-tokens.ts  # POST /v1/messages/count_tokens
│   │   ├── models.ts             # GET /v1/models
│   │   └── health.ts             # GET /health
│   └── __tests__/                 # Integration tests (mock client)
│
├── shared/                        # Cross-process shared code
│   ├── constants.ts               # OAuth URLs, Copilot endpoints, ports, intervals
│   ├── ipc-channels.ts            # IPC channel & event type unions
│   ├── types.ts                   # Shared interfaces (AuthStatus, ProxyStatus, etc.)
│   └── __tests__/
│
└── store/
    └── app-store.ts               # electron-store wrapper (typed getter/setters)
```

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                 Electron Renderer (React)                     │
│  AuthPanel · ProxyPanel · ModelSelector · RequestLog          │
│  State: authStatus, proxyStatus, logs[], config              │
└────────────────────────┬─────────────────────────────────────┘
                         │ IPC (preload.ts contextBridge)
                         │ Channels: auth:*, proxy:*, token:*, models:*, config:*, settings:*
┌────────────────────────▼─────────────────────────────────────┐
│              Electron Main Process (Node.js)                  │
│  ipc-handlers.ts — singleton managers:                        │
│    tokenManager · copilotClient · proxyServer · username      │
│  claude-config.ts — merges proxy into ~/.claude/settings.json │
└─────────┬──────────────────────────────────┬─────────────────┘
          │                                  │
          ▼                                  ▼
┌─────────────────────┐    ┌─────────────────────────────────────┐
│ GitHub OAuth        │    │ Hono Proxy (127.0.0.1:23337)        │
│ Device Flow         │    │                                     │
│ auth.ts             │    │  POST /v1/messages                   │
│   ↓                 │    │    → anthropic-to-openai converter   │
│ Token Manager       │    │    → copilotClient.chatCompletion()  │
│ (auto-refresh 25m)  │    │    → openai-to-anthropic converter   │
│   ↓                 │    │    → stream-transformer (SSE)        │
│ Copilot Client      │    │  GET  /v1/models                    │
│ (HTTP to Copilot)   │    │  POST /v1/messages/count_tokens     │
└─────────────────────┘    │  GET  /health                       │
                           └─────────────────────────────────────┘
                                         │
                                         ▼
                           ┌─────────────────────────────────────┐
                           │   GitHub Copilot API                 │
                           │   api.githubcopilot.com              │
                           │   /chat/completions (OpenAI format)  │
                           │   /models                            │
                           └─────────────────────────────────────┘
```

## Core Data Flows

### 1. Authentication Flow

```
User clicks "Login"
  → ipc-handlers: auth:start-login
    → auth.ts: requestDeviceCode() — GitHub OAuth device flow
    → shell.openExternal(verification_uri)
    → renderer shows user_code for user to type in browser
    → auth.ts: pollForAccessToken() — polls every 5s until authorized
    → app-store: setGithubToken(accessToken)
    → token-manager: initialize() — fetches Copilot JWT
    → copilot-client: created with tokenManager
    → proxy: setCopilotClient(client) — proxy now forwards requests
    → claude-config: applyClaudeConfig() — writes to ~/.claude/settings.json
    → renderer: auth:status-changed event
```

### 2. API Proxy Flow (per request)

```
Claude Code/CLI → POST http://127.0.0.1:23337/v1/messages (Anthropic format)
  → request-logger middleware: captures timing
  → anthropic-messages route:
      1. Auth check → 401 if no copilotClient
      2. Parse JSON body (AnthropicRequest)
      3. convertAnthropicToOpenAI():
         - mapModelName() (claude-sonnet-4-6 → claude-sonnet-4.6)
         - Convert system prompt (string/array → system message)
         - Convert messages (text, image, tool_use, tool_result blocks)
         - Filter out thinking blocks (Copilot doesn't support)
         - Convert tool definitions
      4. If streaming:
         - copilotClient.chatCompletionStream()
         - stream-transformer: OpenAI SSE → Anthropic SSE events
         - Return SSE response
      5. If non-streaming:
         - copilotClient.chatCompletion()
         - convertOpenAIToAnthropic()
         - Return JSON
      6. Error handling: context_window_exceeded → inflate token count
  → request-logger: log entry sent via IPC to renderer
```

### 3. Token Lifecycle

```
TokenManager:
  - initialize(): fetch Copilot JWT using GitHub access token
  - Auto-refresh: setInterval every 25 minutes (token expires at 30min)
  - getToken(): return cached token if valid, refresh if expired
  - 60-second grace period: proactively refresh near expiry
  - Callbacks: onTokenRefreshed, onTokenError
  - dispose(): clear interval and state
```

## IPC Contract

### Request/Response Channels (ipcMain.handle ↔ invoke)

| Channel | Direction | Payload / Return |
|---------|-----------|-----------------|
| `auth:start-login` | Renderer → Main | Returns `AuthStatus` |
| `auth:logout` | Renderer → Main | Returns `AuthStatus` |
| `auth:get-status` | Renderer → Main | Returns `AuthStatus` |
| `proxy:start` | Renderer → Main | Returns `ProxyStatus` |
| `proxy:stop` | Renderer → Main | Returns `ProxyStatus` |
| `proxy:get-status` | Renderer → Main | Returns `ProxyStatus` |
| `token:get-info` | Renderer → Main | Returns `TokenInfo` |
| `config:get` | Renderer → Main | Returns `AppConfig` |
| `models:get-available` | Renderer → Main | Returns `ModelInfo[]` |
| `models:get-selected` | Renderer → Main | Returns `string \| null` |
| `models:set-selected` | Renderer → Main | Accepts `modelId`, returns `string` |
| `settings:get-auto-start` | Renderer → Main | Returns `boolean` |
| `settings:set-auto-start` | Renderer → Main | Accepts `boolean`, returns `boolean` |

### Push Events (webContents.send)

| Event | Direction | Payload |
|-------|-----------|---------|
| `auth:status-changed` | Main → Renderer | `AuthStatus` |
| `proxy:status-changed` | Main → Renderer | `ProxyStatus` |
| `token:info-changed` | Main → Renderer | `TokenInfo` |
| `proxy:request-log` | Main → Renderer | `RequestLogEntry` |

## Key Type Definitions

```typescript
// Persistent storage schema
interface StoreSchema {
  githubToken: string | null;
  proxyPort: number;          // default: 23337
  autoStart: boolean;
  minimizeToTray: boolean;
  selectedModel: string | null;
}

// Auth status (IPC payload)
interface AuthStatus {
  authenticated: boolean;
  username?: string;
  loginUrl?: string;
  userCode?: string;
}

// Proxy status (IPC payload)
interface ProxyStatus {
  running: boolean;
  port: number;
  requestCount: number;
}

// Request log entry (per proxied request)
interface RequestLogEntry {
  id: string; timestamp: number; method: string; path: string;
  model: string; status: number; durationMs: number;
  inputTokens?: number; outputTokens?: number; stream: boolean;
  error?: string;
}
```

## Converter Module — The Heart of the Proxy

The `converter/` module is the most complex and most tested part of the codebase. It handles:

| File | Responsibility |
|------|---------------|
| `model-mapper.ts` | Anthropic model IDs → Copilot IDs (exact map → date-strip → regex pattern → passthrough) |
| `anthropic-to-openai.ts` | Full request conversion: system prompt, messages (text/image/tool_use/tool_result), tool definitions, thinking-block filtering |
| `openai-to-anthropic.ts` | Response conversion: tool_calls → tool_use blocks, content reconstruction, usage stats |
| `tool-converter.ts` | Tool/function schema translation |
| `stream-transformer.ts` | SSE event-by-event transformation (OpenAI delta format → Anthropic delta format), token accumulation, error injection |

### Model Mapping Strategy (model-mapper.ts)

```
1. Exact lookup in MODEL_MAP → e.g. "claude-sonnet-4-6" → "claude-sonnet-4.6"
2. Strip date suffix (-YYYYMMDD) and retry lookup
3. Regex pattern: claude-{family}-{major}-{minor} → claude-{family}-{major}.{minor}
4. Passthrough unchanged (unknown models)
```

## Testing Patterns

- **Framework**: Vitest with globals (no imports for describe/it/expect)
- **Location**: `__tests__/` directories colocated with source
- **Naming**: `{module}.test.ts`
- **Mocking**: `vi.fn()`, `vi.stubGlobal('fetch', ...)`, fake timers for token refresh
- **Coverage scope**: `converter/`, `copilot/`, `proxy/`, `shared/` (excludes main, renderer, store, server.ts, types.ts)
- **Coverage target**: 80%+

```bash
npm test              # single run
npm run test:watch    # watch mode
npm run test:coverage # with coverage report
```

## Path Aliases

```typescript
"@shared/*"    → "src/shared/*"
"@copilot/*"   → "src/copilot/*"
"@converter/*" → "src/converter/*"
"@proxy/*"     → "src/proxy/*"
"@store/*"     → "src/store/*"
```

## Conventions

| Convention | Detail |
|-----------|--------|
| Logging | `console.log("[Module] message")` — bracketed prefix per module |
| IPC type safety | `satisfies IpcChannels` on all handler registrations |
| Route registration | `registerXxxRoutes(app, ...)` factory functions |
| Error responses | Structured JSON: `{ type: "error", error: { type, message } }` |
| Constants | All magic values in `shared/constants.ts` |
| State management | Main: module-level singletons. Renderer: React useState + IPC events |
| Immutability | Return new objects from state queries, no in-place mutation |
| File size | Modules stay under 200-300 lines |

## External Integrations

| Service | URL | Purpose |
|---------|-----|---------|
| GitHub OAuth | `github.com/login/device/code` | Device flow auth |
| GitHub API | `api.github.com/copilot_internal/v2/token` | Copilot JWT token |
| Copilot Chat | `api.githubcopilot.com/chat/completions` | Proxy target |
| Claude Config | `~/.claude/settings.json`, `~/.claude.json` | Auto-configure Claude Code |

## Security Model

- **Context isolation**: enabled (preload bridge, no nodeIntegration)
- **Proxy binding**: `127.0.0.1` only (not exposed to network)
- **Token storage**: electron-store (OS-level encryption)
- **Token rotation**: auto-refresh every 25 minutes
- **Config merging**: non-destructive (preserves existing Claude settings)
- **Cleanup**: logout removes proxy config from Claude settings

## Build & Package

```bash
npm start          # dev (electron-forge + vite HMR)
npm run package    # package (no signing)
npm run make       # build installers (Squirrel for Windows, ZIP for macOS/Linux)
```

Forge config: `forge.config.ts` — includes `afterCopy` hook to strip `"type": "module"` from package.json for CJS compatibility in Electron.

## Quick Reference: Where to Look

| Task | Start here |
|------|-----------|
| Add a new API route | `src/proxy/routes/` — create file, register in `server.ts` |
| Fix message conversion | `src/converter/` — check anthropic-to-openai or openai-to-anthropic |
| Add model support | `src/converter/model-mapper.ts` — add to MODEL_MAP |
| Change auth behavior | `src/copilot/auth.ts` + `src/main/ipc-handlers.ts` |
| Add UI feature | `src/renderer/components/` — add component, wire in `App.tsx` |
| Add IPC channel | `src/shared/ipc-channels.ts` → `src/preload.ts` → `src/main/ipc-handlers.ts` |
| Change persistent settings | `src/shared/types.ts` (StoreSchema) → `src/store/app-store.ts` |
| Debug token issues | `src/copilot/token-manager.ts` |
| Fix streaming bugs | `src/converter/stream-transformer.ts` |
