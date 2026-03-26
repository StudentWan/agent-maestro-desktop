import { contextBridge, ipcRenderer } from "electron";
import type { IpcChannels } from "./shared/ipc-channels";

const api = {
  // Auth
  startLogin: () => ipcRenderer.invoke("auth:start-login" satisfies IpcChannels),
  logout: () => ipcRenderer.invoke("auth:logout" satisfies IpcChannels),
  getAuthStatus: () => ipcRenderer.invoke("auth:get-status" satisfies IpcChannels),

  // Proxy
  startProxy: () => ipcRenderer.invoke("proxy:start" satisfies IpcChannels),
  stopProxy: () => ipcRenderer.invoke("proxy:stop" satisfies IpcChannels),
  getProxyStatus: () => ipcRenderer.invoke("proxy:get-status" satisfies IpcChannels),

  // Token
  getTokenInfo: () => ipcRenderer.invoke("token:get-info" satisfies IpcChannels),

  // Config
  getConfig: () => ipcRenderer.invoke("config:get" satisfies IpcChannels),

  // Models
  getAvailableModels: () => ipcRenderer.invoke("models:get-available" satisfies IpcChannels),
  getSelectedModel: () => ipcRenderer.invoke("models:get-selected" satisfies IpcChannels),
  setSelectedModel: (modelId: string) => ipcRenderer.invoke("models:set-selected" satisfies IpcChannels, modelId),

  // Settings
  getAutoStart: () => ipcRenderer.invoke("settings:get-auto-start" satisfies IpcChannels),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke("settings:set-auto-start" satisfies IpcChannels, enabled),

  // Events from main process
  onAuthStatusChanged: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on("auth:status-changed", listener);
    return () => ipcRenderer.removeListener("auth:status-changed", listener);
  },
  onProxyStatusChanged: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on("proxy:status-changed", listener);
    return () => ipcRenderer.removeListener("proxy:status-changed", listener);
  },
  onTokenInfoChanged: (callback: (info: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: unknown) => callback(info);
    ipcRenderer.on("token:info-changed", listener);
    return () => ipcRenderer.removeListener("token:info-changed", listener);
  },
  onRequestLog: (callback: (log: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, log: unknown) => callback(log);
    ipcRenderer.on("proxy:request-log", listener);
    return () => ipcRenderer.removeListener("proxy:request-log", listener);
  },

  // Codespace
  codespace: {
    checkGhCli: () => ipcRenderer.invoke("codespace:check-gh-cli" satisfies IpcChannels),
    list: () => ipcRenderer.invoke("codespace:list" satisfies IpcChannels),
    connect: (name: string) => ipcRenderer.invoke("codespace:connect" satisfies IpcChannels, name),
    disconnect: (name: string) => ipcRenderer.invoke("codespace:disconnect" satisfies IpcChannels, name),
    disconnectAll: () => ipcRenderer.invoke("codespace:disconnect-all" satisfies IpcChannels),
    getConnections: () => ipcRenderer.invoke("codespace:get-connections" satisfies IpcChannels),
    onStatusChanged: (callback: (connection: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, connection: unknown) => callback(connection);
      ipcRenderer.on("codespace:status-changed", listener);
      return () => ipcRenderer.removeListener("codespace:status-changed", listener);
    },
    onError: (callback: (error: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, error: unknown) => callback(error);
      ipcRenderer.on("codespace:connection-error", listener);
      return () => ipcRenderer.removeListener("codespace:connection-error", listener);
    },
  },

  // Codespace Auto-Detection
  autoDetect: {
    start: () => ipcRenderer.invoke("codespace:start-auto-detect" satisfies IpcChannels),
    stop: () => ipcRenderer.invoke("codespace:stop-auto-detect" satisfies IpcChannels),
    getState: () => ipcRenderer.invoke("codespace:get-auto-detect-state" satisfies IpcChannels),
    setConfig: (config: Record<string, unknown>) =>
      ipcRenderer.invoke("codespace:set-auto-connect-config" satisfies IpcChannels, config),
    retryScopeConnections: () =>
      ipcRenderer.invoke("codespace:retry-scope-connections" satisfies IpcChannels),
    onAutoDetected: (callback: (codespace: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, codespace: unknown) => callback(codespace);
      ipcRenderer.on("codespace:auto-detected", listener);
      return () => ipcRenderer.removeListener("codespace:auto-detected", listener);
    },
    onAutoConnected: (callback: (codespace: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, codespace: unknown) => callback(codespace);
      ipcRenderer.on("codespace:auto-connected", listener);
      return () => ipcRenderer.removeListener("codespace:auto-connected", listener);
    },
    onAutoDisconnected: (callback: (name: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, name: unknown) => callback(name);
      ipcRenderer.on("codespace:auto-disconnected", listener);
      return () => ipcRenderer.removeListener("codespace:auto-disconnected", listener);
    },
    onScopeRequired: (callback: (codespace: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, codespace: unknown) => callback(codespace);
      ipcRenderer.on("codespace:scope-required", listener);
      return () => ipcRenderer.removeListener("codespace:scope-required", listener);
    },
    onAutoConnectError: (callback: (error: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, error: unknown) => callback(error);
      ipcRenderer.on("codespace:auto-connect-error", listener);
      return () => ipcRenderer.removeListener("codespace:auto-connect-error", listener);
    },
  },
};

export type CopilotBridgeAPI = typeof api;

contextBridge.exposeInMainWorld("copilotBridge", api);
