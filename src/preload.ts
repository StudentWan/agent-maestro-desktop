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
};

export type CopilotBridgeAPI = typeof api;

contextBridge.exposeInMainWorld("copilotBridge", api);
