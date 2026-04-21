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

export type CodespaceConnectionSource = "manual" | "vscode-auto";

/**
 * Sub-phase of the high-level connectionState. Lets the UI show what's
 * actually happening inside "connecting" / "reconnecting" / "disconnecting"
 * instead of a single opaque spinner.
 *
 * Mapping by parent state:
 *   connecting:     allocating-port → opening-tunnel → writing-config
 *                   → verifying-config → starting-health-check
 *   reconnecting:   checking-state → waiting-backoff → opening-tunnel
 *                   → writing-config → verifying-config
 *   disconnecting:  checking-state → cleaning-remote
 */
export type CodespaceConnectionPhase =
  | "allocating-port"
  | "opening-tunnel"
  | "writing-config"
  | "verifying-config"
  | "starting-health-check"
  | "waiting-backoff"
  | "checking-state"
  | "cleaning-remote";

export interface CodespaceConnectionProgress {
  phase: CodespaceConnectionPhase;
  /** 1-based attempt counter for retry-bearing phases. */
  attempt?: number;
  maxAttempts?: number;
  /** Optional human-readable hint, e.g. "port 23339 in use, retrying". */
  detail?: string;
}

/**
 * Structured failure category. Lets the UI render a friendly suggestion
 * without parsing errorMessage. Detailed text stays in errorMessage.
 */
export type CodespaceErrorCode =
  | "port-exhausted"
  | "remote-config-failed"
  | "ssh-tunnel-failed"
  | "max-reconnect-reached"
  | "reconnect-failed";

export interface CodespaceConnection {
  id: string;
  info: CodespaceInfo;
  connectionState: CodespaceConnectionState;
  remotePort: number;
  localPort: number;
  connectedAt: number | null;
  lastHealthCheck: number | null;
  reconnectAttempts: number;
  source: CodespaceConnectionSource;
  /** Present only while in transient states (connecting/reconnecting/disconnecting). */
  progress?: CodespaceConnectionProgress;
  errorCode?: CodespaceErrorCode;
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
