import { ipcMain, shell, BrowserWindow } from "electron";
import type { IpcChannels } from "../shared/ipc-channels";
import { requestDeviceCode, pollForAccessToken, getGitHubUsername } from "../copilot/auth";
import { TokenManager } from "../copilot/token-manager";
import { CopilotClient } from "../copilot/client";
import { ProxyServer } from "../proxy/server";
import { getGithubToken, setGithubToken, getProxyPort } from "../store/app-store";
import type { AuthStatus, ProxyStatus, TokenInfo, AppConfig, RequestLogEntry } from "../shared/types";

let tokenManager: TokenManager | null = null;
let copilotClient: CopilotClient | null = null;
let proxyServer: ProxyServer | null = null;
let username: string | null = null;

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
      anthropicApiKey: "copilot-bridge",
      envVars: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: "copilot-bridge",
      },
    };
    return config;
  });
}

export function cleanup(): void {
  tokenManager?.dispose();
  if (proxyServer?.isRunning()) {
    proxyServer.stop();
  }
}
