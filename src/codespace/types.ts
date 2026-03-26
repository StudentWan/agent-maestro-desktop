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

// ── VS Code Auto-Detection Types ──────────────────────────────────

/** A codespace detected from VS Code's local storage.json */
export interface DetectedCodespace {
  readonly name: string;
  readonly workspacePath: string;
  readonly detectedAt: number;
  readonly source: "vscode-storage";
}

/** Result of diffing two snapshots of detected codespaces */
export interface CodespaceDetectionDiff {
  readonly opened: readonly DetectedCodespace[];
  readonly closed: readonly DetectedCodespace[];
}

/** Configuration for the auto-connect feature */
export interface AutoConnectConfig {
  readonly enabled: boolean;
  readonly autoDisconnectOnClose: boolean;
  readonly debounceMs: number;
  readonly pollingFallbackMs: number;
}

export const DEFAULT_AUTO_CONNECT_CONFIG: AutoConnectConfig = {
  enabled: false,
  autoDisconnectOnClose: false,
  debounceMs: 1500,
  pollingFallbackMs: 10_000,
};

/** Aggregate state exposed to renderer */
export interface AutoDetectState {
  readonly isWatching: boolean;
  readonly config: AutoConnectConfig;
  readonly detectedCodespaces: readonly DetectedCodespace[];
  readonly pendingScopeCodespaces: readonly DetectedCodespace[];
}

/** Shape of VS Code's storage.json window entry (partial) */
export interface VscodeWindowEntry {
  readonly folder?: string;
  readonly folderUri?: string;
  readonly remoteAuthority?: string;
}

/** Partial shape of storage.json relevant to codespace detection */
export interface VscodeStorageJson {
  readonly windowsState?: {
    readonly lastActiveWindow?: VscodeWindowEntry;
    readonly openedWindows?: readonly VscodeWindowEntry[];
  };
}

/** Dependency injection interface for VscodeDetector */
export interface VscodeDetectorDeps {
  readonly readFile: (path: string) => Promise<string>;
  readonly watchFile: (
    path: string,
    callback: () => void,
  ) => { close: () => void };
  readonly fileExists: (path: string) => Promise<boolean>;
  readonly storagePath: string | null;
}
