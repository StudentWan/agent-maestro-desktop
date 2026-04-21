import { ipcMain, shell, BrowserWindow, app } from "electron";
import type { IpcChannels } from "../shared/ipc-channels";
import {
  requestDeviceCode,
  pollForAccessToken,
  getGitHubUsername,
  checkTokenScopes,
  requestCodespaceDeviceCode,
  pollForCodespaceAccessToken,
} from "../copilot/auth";
import { TokenManager } from "../copilot/token-manager";
import { CopilotClient } from "../copilot/client";
import { fetchAvailableModels } from "../copilot/models";
import { ProxyServer } from "../proxy/server";
import {
  getGithubToken,
  setGithubToken,
  getCodespaceToken,
  setCodespaceToken,
  getProxyPort,
  getAutoStart,
  setAutoStart,
  getSelectedModel,
  setSelectedModel,
} from "../store/app-store";
import { applyClaudeConfig, removeClaudeConfig, writeModelToClaudeConfig } from "./claude-config";
import type { AuthStatus, ProxyStatus, TokenInfo, AppConfig, RequestLogEntry, ModelInfo } from "../shared/types";
import { CodespaceManager } from "../codespace/codespace-manager";
import { checkGhCli } from "../codespace/gh-cli";
import { VsCodeCodespaceDetector } from "../codespace/vscode-detector";
import { AutoBridgeOrchestrator } from "../codespace/auto-bridge";
import type { CodespaceConnection, CodespaceInfo, GhCliStatus } from "../codespace/types";

let tokenManager: TokenManager | null = null;
let copilotClient: CopilotClient | null = null;
let proxyServer: ProxyServer | null = null;
let username: string | null = null;
let codespaceManager: CodespaceManager | null = null;
let vscodeDetector: VsCodeCodespaceDetector | null = null;
let autoBridge: AutoBridgeOrchestrator | null = null;
/**
 * Last-known set of missing scopes for the *codespace* token. Empty when the
 * stored codespace token actually carries `codespace`. Drives the in-app
 * "Grant Codespace Access" prompt.
 */
let missingScopes: string[] = ["codespace"];

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows[0] ?? null;
}

function sendToRenderer(channel: string, data: unknown): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

function getAuthStatus(): AuthStatus {
  return {
    authenticated: tokenManager !== null,
    username: username ?? undefined,
    missingScopes: tokenManager !== null ? missingScopes : undefined,
  };
}

function getProxyStatus(): ProxyStatus {
  return {
    running: proxyServer?.isRunning() ?? false,
    port: proxyServer?.getPort() ?? getProxyPort(),
    requestCount: proxyServer?.getRequestCount() ?? 0,
  };
}

function getOrCreateCodespaceManager(): CodespaceManager {
  if (!codespaceManager) {
    const port = proxyServer?.getPort() ?? getProxyPort();
    codespaceManager = new CodespaceManager(port, () => getCodespaceToken() ?? undefined);

    codespaceManager.on("connectionChanged", (connection: CodespaceConnection) => {
      sendToRenderer("codespace:status-changed", connection);

      // If a connection unexpectedly entered a "no longer up" state, the
      // gh-cs-list cache in the detector may still claim it's Available.
      // Invalidate so the next tick reflects reality fast (instead of
      // waiting up to CODESPACE_LIST_CACHE_MS).
      if (
        connection.connectionState === "available" ||
        connection.connectionState === "error" ||
        connection.connectionState === "reconnecting"
      ) {
        vscodeDetector?.invalidateCache();
        // Trigger an immediate re-tick so the auto-bridge sees the truth
        // promptly. Best-effort — failures are logged inside tick().
        void vscodeDetector?.tick();
      }
    });

    codespaceManager.on("connectionError", (error: { name: string; message: string }) => {
      sendToRenderer("codespace:connection-error", error);
    });
  }
  return codespaceManager;
}

function ensureAutoBridgeRunning(): void {
  if (autoBridge && vscodeDetector) return;
  const manager = getOrCreateCodespaceManager();
  vscodeDetector = new VsCodeCodespaceDetector({
    getToken: () => getCodespaceToken() ?? undefined,
    getExcludePids: () => manager.getOwnPids(),
  });
  autoBridge = new AutoBridgeOrchestrator(vscodeDetector, manager, {
    getModel: () => getSelectedModel() ?? "",
  });
  vscodeDetector.start();
  autoBridge.start();
  console.log("[IPC] VS Code Codespace auto-bridge started");
}

/**
 * Refresh the cached `missingScopes` for the currently stored CODESPACE
 * token. If no codespace token is stored, missing = ["codespace"].
 */
async function refreshMissingScopes(): Promise<void> {
  const csToken = getCodespaceToken();
  if (!csToken) {
    missingScopes = ["codespace"];
    return;
  }
  try {
    const status = await checkTokenScopes(csToken);
    missingScopes = status.missingScopes;
  } catch (err) {
    console.warn("[IPC] Failed to check codespace token scopes:", err);
    // Don't toggle the prompt off on a transient blip — keep last value.
  }
}

/**
 * Start the proxy server (always, regardless of auth state).
 * The proxy returns 401 for messages requests when not authenticated.
 */
async function ensureProxyRunning(): Promise<void> {
  if (proxyServer?.isRunning()) return;

  const port = getProxyPort();
  proxyServer = new ProxyServer(port);
  proxyServer.setCopilotClient(copilotClient);
  proxyServer.setLogCallback((entry: RequestLogEntry) => {
    sendToRenderer("proxy:request-log", entry);
  });

  try {
    await proxyServer.start();
    console.log(`[IPC] Proxy server started on port ${port}`);
  } catch (error) {
    console.error("[IPC] Failed to start proxy server:", error);
  }
  sendToRenderer("proxy:status-changed", getProxyStatus());
}

/**
 * Try to restore a session from stored GitHub token
 */
async function initializeFromStoredToken(): Promise<boolean> {
  const storedToken = getGithubToken();
  if (!storedToken) return false;

  try {
    username = await getGitHubUsername(storedToken);

    tokenManager = new TokenManager(storedToken, {
      onTokenRefreshed: () => {
        sendToRenderer("token:info-changed", tokenManager!.getTokenInfo());
      },
      onTokenError: (error) => {
        console.error("[IPC] Token refresh error:", error.message);
      },
    });

    await tokenManager.initialize();
    copilotClient = new CopilotClient(tokenManager);

    // Update the already-running proxy with the client
    proxyServer?.setCopilotClient(copilotClient);

    // Check codespace-token scopes (independent of the Copilot token).
    await refreshMissingScopes();

    return true;
  } catch (error) {
    console.error("[IPC] Failed to restore session:", error);
    setGithubToken(null);
    return false;
  }
}

/**
 * Run the primary GitHub Device Flow (Copilot OAuth App, `read:user`) and
 * install the resulting token. Used by `auth:start-login` only.
 */
async function runCopilotDeviceFlowAndInstallToken(): Promise<AuthStatus> {
  const deviceCode = await requestDeviceCode();

  shell.openExternal(deviceCode.verification_uri);

  sendToRenderer("auth:status-changed", {
    authenticated: false,
    userCode: deviceCode.user_code,
    loginUrl: deviceCode.verification_uri,
  } satisfies AuthStatus);

  const accessToken = await pollForAccessToken(
    deviceCode.device_code,
    deviceCode.interval * 1000,
    deviceCode.expires_in,
  );

  // Tear down any previous TokenManager so timers don't pile up.
  tokenManager?.dispose();
  tokenManager = null;
  copilotClient = null;

  setGithubToken(accessToken);
  username = await getGitHubUsername(accessToken);

  tokenManager = new TokenManager(accessToken, {
    onTokenRefreshed: () => {
      sendToRenderer("token:info-changed", tokenManager!.getTokenInfo());
    },
    onTokenError: (error) => {
      console.error("[IPC] Token refresh error:", error.message);
    },
  });
  await tokenManager.initialize();

  copilotClient = new CopilotClient(tokenManager);
  proxyServer?.setCopilotClient(copilotClient);

  // After fresh login, check whether we ALREADY have a codespace token
  // (e.g., user logged out without revoking the codespace grant). If yes,
  // missingScopes will be [] and the banner stays hidden.
  await refreshMissingScopes();

  const status = getAuthStatus();
  sendToRenderer("auth:status-changed", status);
  sendToRenderer("proxy:status-changed", getProxyStatus());

  // Auto-configure Claude Code to use our proxy
  const port = proxyServer?.getPort() ?? getProxyPort();
  applyClaudeConfig(port).catch((err) => {
    console.error("[IPC] Failed to apply Claude config:", err);
  });

  // Start the VS Code Codespace auto-bridge (it'll be a no-op if codespace
  // token is missing — connect attempts will fail until user grants).
  ensureAutoBridgeRunning();

  return status;
}

/**
 * Run the secondary device flow (gh CLI client_id, `codespace` scope) and
 * persist the resulting token separately. Verifies the resulting token
 * actually has `codespace` before claiming success — guards against the
 * silent-scope-drop bug we hit on the Copilot OAuth App.
 */
async function runCodespaceDeviceFlow(): Promise<AuthStatus> {
  const deviceCode = await requestCodespaceDeviceCode();

  shell.openExternal(deviceCode.verification_uri);

  // Show the user code while keeping the existing authenticated state.
  sendToRenderer("auth:status-changed", {
    authenticated: tokenManager !== null,
    username: username ?? undefined,
    missingScopes,
    userCode: deviceCode.user_code,
    loginUrl: deviceCode.verification_uri,
  } satisfies AuthStatus);

  const csToken = await pollForCodespaceAccessToken(
    deviceCode.device_code,
    deviceCode.interval * 1000,
    deviceCode.expires_in,
  );

  // Verify scope BEFORE persisting. If GitHub for some reason gave us a
  // token without `codespace`, surface that as an error rather than silently
  // looping the user back to the same banner.
  const scopeStatus = await checkTokenScopes(csToken);
  if (!scopeStatus.hasAllRequiredScopes) {
    throw new Error(
      `Authorization completed but token is missing required scope(s): ${scopeStatus.missingScopes.join(", ")}`,
    );
  }

  setCodespaceToken(csToken);
  missingScopes = [];

  const status = getAuthStatus();
  sendToRenderer("auth:status-changed", status);

  // Now that the token exists, kick the auto-bridge so it can re-run with
  // working creds.
  ensureAutoBridgeRunning();

  return status;
}

export function registerIpcHandlers(): void {
  // Start proxy server immediately (returns 401 until authenticated)
  ensureProxyRunning();

  // Try restoring session from stored token
  initializeFromStoredToken().then((restored) => {
    if (restored) {
      console.log("[IPC] Session restored for user:", username);
      sendToRenderer("auth:status-changed", getAuthStatus());
      sendToRenderer("proxy:status-changed", getProxyStatus());

      // Auto-configure Claude Code to use our proxy
      const port = proxyServer?.getPort() ?? getProxyPort();
      applyClaudeConfig(port).catch((err) => {
        console.error("[IPC] Failed to apply Claude config:", err);
      });

      // Start the VS Code Codespace auto-bridge
      ensureAutoBridgeRunning();
    }
  });

  // --- Auth handlers ---

  ipcMain.handle("auth:start-login" satisfies IpcChannels, async () => {
    try {
      return await runCopilotDeviceFlowAndInstallToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[IPC] Login failed:", message);
      return { authenticated: false, error: message } satisfies AuthStatus;
    }
  });

  ipcMain.handle("auth:reauthorize" satisfies IpcChannels, async () => {
    try {
      return await runCodespaceDeviceFlow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[IPC] Codespace authorization failed:", message);
      // Keep current authenticated state visible — don't drop them to the
      // logged-out screen just because they cancelled or it failed.
      const status = { ...getAuthStatus(), error: message } satisfies AuthStatus;
      sendToRenderer("auth:status-changed", status);
      return status;
    }
  });

  ipcMain.handle("auth:logout" satisfies IpcChannels, async () => {
    // Stop auto-bridge so it doesn't reconnect during logout
    autoBridge?.stop();
    autoBridge = null;
    vscodeDetector?.stop();
    vscodeDetector = null;

    // Dispose token manager and client
    tokenManager?.dispose();
    tokenManager = null;
    copilotClient = null;
    username = null;
    missingScopes = ["codespace"];

    // Update proxy to remove client (will return 401 for auth-required routes)
    proxyServer?.setCopilotClient(null);

    // Clear stored token
    setGithubToken(null);
    // Codespace token is also user-private — clear it on logout so the next
    // user gets a clean re-authorize prompt.
    setCodespaceToken(null);

    // Remove Claude Code proxy configuration
    const port = proxyServer?.getPort() ?? getProxyPort();
    removeClaudeConfig(port).catch((err) => {
      console.error("[IPC] Failed to remove Claude config:", err);
    });

    const status = getAuthStatus();
    sendToRenderer("auth:status-changed", status);
    sendToRenderer("proxy:status-changed", getProxyStatus());

    return status;
  });

  ipcMain.handle("auth:get-status" satisfies IpcChannels, () => {
    return getAuthStatus();
  });

  // --- Proxy handlers ---

  ipcMain.handle("proxy:start" satisfies IpcChannels, async () => {
    await ensureProxyRunning();
    return getProxyStatus();
  });

  ipcMain.handle("proxy:stop" satisfies IpcChannels, async () => {
    if (proxyServer?.isRunning()) {
      await proxyServer.stop();
      proxyServer = null;
    }
    const status = getProxyStatus();
    sendToRenderer("proxy:status-changed", status);
    return status;
  });

  ipcMain.handle("proxy:get-status" satisfies IpcChannels, () => {
    return getProxyStatus();
  });

  // --- Token handlers ---

  ipcMain.handle("token:get-info" satisfies IpcChannels, () => {
    return tokenManager?.getTokenInfo() ?? {
      token: null,
      expiresAt: null,
      remainingSeconds: null,
    };
  });

  // --- Config handlers ---

  ipcMain.handle("config:get" satisfies IpcChannels, () => {
    const port = proxyServer?.getPort() ?? getProxyPort();
    const config: AppConfig = {
      proxyPort: port,
      anthropicBaseUrl: `http://127.0.0.1:${port}`,
      anthropicAuthToken: "Powered by Agent Maestro Desktop",
      envVars: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_AUTH_TOKEN: "Powered by Agent Maestro Desktop",
      },
    };
    return config;
  });

  // --- Model handlers ---

  ipcMain.handle("models:get-available" satisfies IpcChannels, async () => {
    if (!tokenManager) {
      return [];
    }
    try {
      const models = await fetchAvailableModels(tokenManager);

      // Auto-select first model if none is currently selected
      const currentModel = getSelectedModel();
      if ((!currentModel || currentModel === "") && models.length > 0) {
        const firstModel = models[0].id;
        setSelectedModel(firstModel);
        await writeModelToClaudeConfig(firstModel);
        console.log(`[IPC] Auto-selected first model: ${firstModel}`);
      }

      return models;
    } catch (error) {
      console.error("[IPC] Failed to fetch models:", error);
      return [];
    }
  });

  ipcMain.handle("models:get-selected" satisfies IpcChannels, () => {
    return getSelectedModel();
  });

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

  // --- Settings handlers ---

  ipcMain.handle("settings:get-auto-start" satisfies IpcChannels, () => {
    return getAutoStart();
  });

  ipcMain.handle("settings:set-auto-start" satisfies IpcChannels, (_event, enabled: boolean) => {
    setAutoStart(enabled);
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: enabled });
    }
    return enabled;
  });

  // --- Codespace handlers ---

  ipcMain.handle("codespace:check-gh-cli" satisfies IpcChannels, async (): Promise<GhCliStatus> => {
    return checkGhCli();
  });

  ipcMain.handle("codespace:list" satisfies IpcChannels, async (): Promise<CodespaceInfo[]> => {
    const manager = getOrCreateCodespaceManager();
    return manager.list();
  });

  /**
   * Returns the names of codespaces the local VS Code is currently
   * connected to. Used by the renderer to filter the codespace list down
   * to "what's actually open right now". Returns [] if the detector hasn't
   * ticked yet or no VS Code window has a Codespaces title.
   */
  ipcMain.handle("codespace:list-active-vscode" satisfies IpcChannels, (): string[] => {
    if (!vscodeDetector) return [];
    return Array.from(vscodeDetector.getCurrent().keys());
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

  ipcMain.handle("codespace:dismiss" satisfies IpcChannels, (_event, name: string): void => {
    const manager = getOrCreateCodespaceManager();
    manager.dismiss(name);
  });

  ipcMain.handle("codespace:get-connections" satisfies IpcChannels, (): CodespaceConnection[] => {
    const manager = getOrCreateCodespaceManager();
    return manager.getConnections();
  });
}

export function cleanup(): void {
  // Stop auto-bridge first so it doesn't try to act during shutdown
  autoBridge?.stop();
  autoBridge = null;
  vscodeDetector?.stop();
  vscodeDetector = null;

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
