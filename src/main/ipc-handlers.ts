import { ipcMain, shell, BrowserWindow, app } from "electron";
import type { IpcChannels } from "../shared/ipc-channels";
import { requestDeviceCode, pollForAccessToken, getGitHubUsername } from "../copilot/auth";
import { TokenManager } from "../copilot/token-manager";
import { CopilotClient } from "../copilot/client";
import { fetchAvailableModels } from "../copilot/models";
import { ProxyServer } from "../proxy/server";
import { getGithubToken, setGithubToken, getProxyPort, getAutoStart, setAutoStart, getSelectedModel, setSelectedModel } from "../store/app-store";
import { applyClaudeConfig, removeClaudeConfig, writeModelToClaudeConfig } from "./claude-config";
import type { AuthStatus, ProxyStatus, TokenInfo, AppConfig, RequestLogEntry, ModelInfo } from "../shared/types";
import { CodespaceManager } from "../codespace/codespace-manager";
import { checkGhCli, hasCodespaceScope } from "../codespace/gh-cli";
import { AutoConnectOrchestrator } from "../codespace/auto-connect-orchestrator";
import { VscodeDetector } from "../codespace/vscode-detector";
import { getVscodeStoragePath } from "../codespace/vscode-storage-path";
import type { CodespaceConnection, CodespaceInfo, GhCliStatus, AutoConnectConfig, AutoDetectState } from "../codespace/types";
import * as fs from "node:fs";

let tokenManager: TokenManager | null = null;
let copilotClient: CopilotClient | null = null;
let proxyServer: ProxyServer | null = null;
let username: string | null = null;
let codespaceManager: CodespaceManager | null = null;
let autoConnectOrchestrator: AutoConnectOrchestrator | null = null;

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

function getOrCreateAutoConnectOrchestrator(): AutoConnectOrchestrator {
  if (autoConnectOrchestrator) return autoConnectOrchestrator;

  const storagePath = getVscodeStoragePath();
  const detector = new VscodeDetector({
    readFile: (p) => fs.promises.readFile(p, "utf-8"),
    watchFile: (p, cb) => {
      const watcher = fs.watch(p, { persistent: false }, cb);
      return { close: () => watcher.close() };
    },
    fileExists: (p) => fs.promises.access(p).then(() => true, () => false),
    storagePath,
  });

  const csManager = getOrCreateCodespaceManager();

  autoConnectOrchestrator = new AutoConnectOrchestrator({
    detector,
    connectCodespace: async (name: string) => {
      await ensureProxyRunning();
      const codespaces = await csManager.list();
      const info = codespaces.find((cs) => cs.name === name);
      if (!info) {
        throw new Error(`Codespace "${name}" not found via gh API`);
      }
      const model = getSelectedModel() ?? "";
      if (info.state === "Shutdown") {
        await csManager.startAndConnect(info, model);
      } else {
        await csManager.connect(info, model);
      }
    },
    disconnectCodespace: (name: string) => csManager.disconnect(name),
    isCodespaceConnected: (name: string) =>
      csManager.getConnections().some(
        (c) => c.id === name && c.connectionState === "connected",
      ),
    checkCodespaceScope: hasCodespaceScope,
  });

  // Forward auto-detect events to renderer
  autoConnectOrchestrator.on("auto-connected", (cs) => {
    sendToRenderer("codespace:auto-connected", cs);
  });
  autoConnectOrchestrator.on("auto-disconnected", (name) => {
    sendToRenderer("codespace:auto-disconnected", name);
  });
  autoConnectOrchestrator.on("scope-required", (cs) => {
    sendToRenderer("codespace:scope-required", cs);
  });
  autoConnectOrchestrator.on("auto-connect-error", (name, error) => {
    sendToRenderer("codespace:auto-connect-error", { name, message: String(error) });
  });

  return autoConnectOrchestrator;
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

    return true;
  } catch (error) {
    console.error("[IPC] Failed to restore session:", error);
    setGithubToken(null);
    return false;
  }
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
    }
  });

  // --- Auth handlers ---

  ipcMain.handle("auth:start-login" satisfies IpcChannels, async () => {
    try {
      const deviceCode = await requestDeviceCode();

      // Open browser for user to enter the code
      shell.openExternal(deviceCode.verification_uri);

      // Send the user code to the renderer to display
      sendToRenderer("auth:status-changed", {
        authenticated: false,
        userCode: deviceCode.user_code,
        loginUrl: deviceCode.verification_uri,
      } satisfies AuthStatus);

      // Poll for access token
      const accessToken = await pollForAccessToken(
        deviceCode.device_code,
        deviceCode.interval * 1000,
        deviceCode.expires_in,
      );

      // Store the token
      setGithubToken(accessToken);

      // Get username
      username = await getGitHubUsername(accessToken);

      // Initialize token manager
      tokenManager = new TokenManager(accessToken, {
        onTokenRefreshed: () => {
          sendToRenderer("token:info-changed", tokenManager!.getTokenInfo());
        },
        onTokenError: (error) => {
          console.error("[IPC] Token refresh error:", error.message);
        },
      });

      await tokenManager.initialize();

      // Create Copilot client and update proxy
      copilotClient = new CopilotClient(tokenManager);
      proxyServer?.setCopilotClient(copilotClient);

      const status = getAuthStatus();
      sendToRenderer("auth:status-changed", status);
      sendToRenderer("proxy:status-changed", getProxyStatus());

      // Auto-configure Claude Code to use our proxy
      const port = proxyServer?.getPort() ?? getProxyPort();
      applyClaudeConfig(port).catch((err) => {
        console.error("[IPC] Failed to apply Claude config:", err);
      });

      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[IPC] Login failed:", message);
      return { authenticated: false, error: message };
    }
  });

  ipcMain.handle("auth:logout" satisfies IpcChannels, async () => {
    // Dispose token manager and client
    tokenManager?.dispose();
    tokenManager = null;
    copilotClient = null;
    username = null;

    // Update proxy to remove client (will return 401 for auth-required routes)
    proxyServer?.setCopilotClient(null);

    // Clear stored token
    setGithubToken(null);

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

  // --- Codespace Auto-Detection handlers ---

  ipcMain.handle("codespace:start-auto-detect" satisfies IpcChannels, async (): Promise<void> => {
    const orchestrator = getOrCreateAutoConnectOrchestrator();
    await orchestrator.start();
  });

  ipcMain.handle("codespace:stop-auto-detect" satisfies IpcChannels, (): void => {
    if (autoConnectOrchestrator) {
      autoConnectOrchestrator.stop();
    }
  });

  ipcMain.handle("codespace:get-auto-detect-state" satisfies IpcChannels, (): AutoDetectState => {
    const orchestrator = getOrCreateAutoConnectOrchestrator();
    return orchestrator.getState();
  });

  ipcMain.handle(
    "codespace:set-auto-connect-config" satisfies IpcChannels,
    (_event, config: Partial<AutoConnectConfig>): AutoConnectConfig => {
      const orchestrator = getOrCreateAutoConnectOrchestrator();
      return orchestrator.updateConfig(config);
    },
  );

  ipcMain.handle("codespace:retry-scope-connections" satisfies IpcChannels, async (): Promise<void> => {
    if (autoConnectOrchestrator) {
      await autoConnectOrchestrator.retryPendingConnections();
    }
  });
}

export function cleanup(): void {
  // Stop auto-detection
  if (autoConnectOrchestrator) {
    autoConnectOrchestrator.stop();
    autoConnectOrchestrator = null;
  }
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
