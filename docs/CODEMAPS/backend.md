<!-- Generated: 2026-03-24 | Files scanned: 12 | Token estimate: ~600 -->

# Backend (Proxy Server + IPC)

## Proxy Routes (Hono on 127.0.0.1:23337)

```
POST /v1/messages         → registerMessagesRoute  → convertAnthropicToOpenAI → CopilotClient → convertOpenAIToAnthropic
POST /v1/messages/count_tokens → registerCountTokensRoute → token estimation
GET  /v1/models           → registerModelsRoutes   → fetchAvailableModels via TokenManager
GET  /health              → registerHealthRoutes   → { status: "ok" }
```

## Middleware Chain

```
Request → CORS → RequestLogger → Route Handler → Response
```

## IPC Channels (Main Process ↔ Renderer)

### Invoke (request/response)
```
auth:start-login        → Device Flow OAuth → TokenManager → CopilotClient
auth:logout             → dispose token, clear store, remove claude config
auth:get-status         → { authenticated, username }
proxy:start             → ensureProxyRunning()
proxy:stop              → proxyServer.stop()
proxy:get-status        → { running, port, requestCount }
token:get-info          → { token, expiresAt, remainingSeconds }
config:get              → { proxyPort, baseUrl, authToken, envVars }
models:get-available    → fetchAvailableModels() → auto-select first
models:get-selected     → store.get("selectedModel")
models:set-selected     → writeModelToClaudeConfig + codespace propagation
settings:get-auto-start → store.get("autoStart")
settings:set-auto-start → store.set + app.setLoginItemSettings
codespace:check-gh-cli  → checkGhCli() → { installed, version, auth }
codespace:list          → gh api /user/codespaces
codespace:connect       → CodespaceManager.connect() or startAndConnect()
codespace:disconnect    → CodespaceManager.disconnect()
codespace:disconnect-all → CodespaceManager.disconnectAll()
codespace:get-connections → CodespaceManager.getConnections()
```

### Events (push to renderer)
```
auth:status-changed     ← AuthStatus
proxy:status-changed    ← ProxyStatus
token:info-changed      ← TokenInfo
proxy:request-log       ← RequestLogEntry
codespace:status-changed     ← CodespaceConnection
codespace:connection-error   ← { name, message }
```

## Key Files

```
src/proxy/server.ts              (115 lines) Hono app, route registration
src/proxy/routes/anthropic-messages.ts (189 lines) Main message route, streaming
src/proxy/middleware/request-logger.ts  (34 lines) Request timing & logging
src/main/ipc-handlers.ts         (397 lines) All IPC handlers, state management
src/main/claude-config.ts        (106 lines) Write ~/.claude/settings.json
src/copilot/client.ts            (57 lines)  Copilot API HTTP client
src/copilot/token-manager.ts     (127 lines) JWT auto-refresh (25min interval)
src/copilot/auth.ts              (111 lines) GitHub OAuth Device Flow
```

## Auth Token Lifecycle

```
GitHub OAuth (read:user scope)
  → GitHub Access Token (stored in electron-store)
  → POST /copilot_internal/v2/token
  → Copilot JWT (30min expiry, auto-refresh at 25min)
  → Used in Authorization: Bearer header for Copilot API
```
