// src/codespace/types.ts

export type CodespaceConnectionState =
  | "available"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "reconnecting"
  | "error";

export type CodespaceApiState = string;

export const KNOWN_CODESPACE_STATES = {
  AVAILABLE: "Available",
  SHUTDOWN: "Shutdown",
  STARTING: "Starting",
  REBUILDING: "Rebuilding",
  QUEUED: "Queued",
  ARCHIVED: "Archived",
  SHUTTING_DOWN: "ShuttingDown",
  FAILED: "Failed",
  EXPORTING: "Exporting",
  UPDATING: "Updating",
  PROVISIONING: "Provisioning",
} as const;

export interface CodespaceInfo {
  id: number;
  name: string;
  displayName: string;
  repository: string;
  state: CodespaceApiState;
  machine: string;
  lastUsedAt: string;
}

export interface CodespaceConnection {
  id: string;
  info: CodespaceInfo;
  connectionState: CodespaceConnectionState;
  remotePort: number;
  localPort: number;
  connectedAt: number | null;
  lastHealthCheck: number | null;
  reconnectAttempts: number;
  errorMessage?: string;
}

export interface GhCliStatus {
  installed: boolean;
  version?: string;
  meetsMinVersion: boolean;
  authenticated: boolean;
  hasCodespaceScope: boolean;
}

export const MIN_GH_CLI_VERSION = "2.13.0";
