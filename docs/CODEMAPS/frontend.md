<!-- Generated: 2026-03-24 | Files scanned: 11 | Token estimate: ~500 -->

# Frontend (React Renderer)

## Component Tree

```
App.tsx (119 lines) — root, state: authStatus, proxyStatus, config, logs
├── AuthPanel.tsx (66 lines) — login/logout buttons, device code display
├── ProxyPanel.tsx (58 lines) — start/stop proxy, status indicator
├── ModelSelector.tsx (75 lines) — dropdown of available Claude models
├── SettingsPanel.tsx (43 lines) — auto-start toggle
├── CodespacePanel.tsx (291 lines) — codespace list, connect/disconnect
│   ├── gh CLI status bar (version, auth, scope warnings)
│   ├── Codespace list (sorted by lastUsedAt)
│   │   ├── Connected: 🟢 + Disconnect button
│   │   ├── Available: ⚪ + Connect button
│   │   ├── Shutdown: ⚪ + Start & Connect button
│   │   ├── Error: 🔴 + Reconnect/Dismiss buttons
│   │   └── Other: greyed out with state label
│   └── Auto-refresh: 60s polling, pause when tab hidden
├── ConfigPanel.tsx (55 lines) — env vars display (when proxy running)
├── RequestLog.tsx (103 lines) — paginated log table (max 200 entries)
└── StatusBar.tsx (37 lines) — footer with auth + proxy status icons
```

## State Management

```
App.tsx (local useState):
  authStatus  ← IPC: auth:status-changed
  proxyStatus ← IPC: proxy:status-changed
  config      ← IPC: config:get (refreshed on proxy change)
  logs[]      ← IPC: proxy:request-log (max 200, newest first)

CodespacePanel.tsx (local useState):
  ghStatus    ← IPC: codespace:check-gh-cli
  codespaces  ← IPC: codespace:list (60s polling)
  connections ← IPC: codespace:status-changed (real-time)
  loading     ← local
  error       ← local + IPC: codespace:connection-error
```

## Bridge API (window.copilotBridge)

```typescript
// Invoke (returns Promise)
startLogin, logout, getAuthStatus
startProxy, stopProxy, getProxyStatus
getTokenInfo, getConfig
getAvailableModels, getSelectedModel, setSelectedModel
getAutoStart, setAutoStart

// Codespace namespace
codespace.checkGhCli, codespace.list
codespace.connect, codespace.disconnect, codespace.disconnectAll
codespace.getConnections

// Events (returns cleanup function)
onAuthStatusChanged, onProxyStatusChanged
onTokenInfoChanged, onRequestLog
codespace.onStatusChanged, codespace.onError
```

## Styling

- **Framework**: Tailwind CSS 3.4 (dark theme)
- **Color scheme**: `bg-gray-900` (body), `bg-gray-800` (panels), `border-gray-700`
- **Status colors**: green-400 (active), red-400 (error), yellow-400 (pending), gray-500 (inactive)
