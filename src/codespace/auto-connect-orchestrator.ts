import { EventEmitter } from "node:events";
import type {
  DetectedCodespace,
  AutoConnectConfig,
  AutoDetectState,
} from "./types";
import { DEFAULT_AUTO_CONNECT_CONFIG } from "./types";

// ── Dependency injection interface ────────────────────────────

export interface AutoConnectDeps {
  readonly detector: {
    start(): Promise<void>;
    stop(): void;
    readonly isWatching: boolean;
    readonly detectedCodespaces: readonly DetectedCodespace[];
    on(
      event: "codespace-opened",
      listener: (cs: DetectedCodespace) => void,
    ): void;
    on(
      event: "codespace-closed",
      listener: (cs: DetectedCodespace) => void,
    ): void;
    removeAllListeners(event?: string): void;
  };
  readonly connectCodespace: (name: string) => Promise<void>;
  readonly disconnectCodespace: (name: string) => Promise<void>;
  readonly isCodespaceConnected: (name: string) => boolean;
  readonly checkCodespaceScope: () => Promise<boolean>;
}

// ── AutoConnectOrchestrator ───────────────────────────────────

/**
 * Orchestrates automatic connection/disconnection of codespaces
 * detected by the VS Code storage watcher.
 *
 * Events:
 *  - `auto-connected`     (cs: DetectedCodespace)
 *  - `auto-disconnected`  (name: string)
 *  - `scope-required`     (cs: DetectedCodespace)
 *  - `auto-connect-error` (name: string, error: Error)
 */
export class AutoConnectOrchestrator extends EventEmitter {
  private _config: AutoConnectConfig;
  private readonly _deps: AutoConnectDeps;
  private _autoConnectedNames: ReadonlySet<string> = new Set();
  private _pendingScopeCodespaces: readonly DetectedCodespace[] = [];

  constructor(deps: AutoConnectDeps, config?: Partial<AutoConnectConfig>) {
    super();
    this._deps = deps;
    this._config = { ...DEFAULT_AUTO_CONNECT_CONFIG, ...config };
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    this._deps.detector.on(
      "codespace-opened",
      this._onCodespaceOpened.bind(this),
    );
    this._deps.detector.on(
      "codespace-closed",
      this._onCodespaceClosed.bind(this),
    );
    await this._deps.detector.start();
  }

  stop(): void {
    this._deps.detector.removeAllListeners();
    this._deps.detector.stop();
  }

  // ── Configuration ──────────────────────────────────────────

  updateConfig(partial: Partial<AutoConnectConfig>): AutoConnectConfig {
    this._config = { ...this._config, ...partial };
    return this._config;
  }

  // ── State ──────────────────────────────────────────────────

  getState(): AutoDetectState {
    return Object.freeze({
      isWatching: this._deps.detector.isWatching,
      config: this._config,
      detectedCodespaces: this._deps.detector.detectedCodespaces,
      pendingScopeCodespaces: this._pendingScopeCodespaces,
    });
  }

  // ── Retry pending ──────────────────────────────────────────

  async retryPendingConnections(): Promise<void> {
    if (this._pendingScopeCodespaces.length === 0) return;

    const hasScope = await this._deps.checkCodespaceScope();
    if (!hasScope) return;

    const pending = this._pendingScopeCodespaces;
    this._pendingScopeCodespaces = [];

    await Promise.all(
      pending.map((cs) => this._connectWithTracking(cs)),
    );
  }

  // ── Event handlers (private) ───────────────────────────────

  private _onCodespaceOpened(cs: DetectedCodespace): void {
    if (!this._config.enabled) return;
    if (this._deps.isCodespaceConnected(cs.name)) return;

    // Fire-and-forget async work; errors handled internally
    void this._handleOpened(cs);
  }

  private async _handleOpened(cs: DetectedCodespace): Promise<void> {
    const hasScope = await this._deps.checkCodespaceScope();

    if (!hasScope) {
      this._pendingScopeCodespaces = [
        ...this._pendingScopeCodespaces,
        cs,
      ];
      this.emit("scope-required", cs);
      return;
    }

    await this._connectWithTracking(cs);
  }

  private _onCodespaceClosed(cs: DetectedCodespace): void {
    if (!this._config.autoDisconnectOnClose) return;
    if (!this._autoConnectedNames.has(cs.name)) return;

    void this._handleClosed(cs.name);
  }

  private async _handleClosed(name: string): Promise<void> {
    try {
      await this._deps.disconnectCodespace(name);
      this._autoConnectedNames = new Set(
        [...this._autoConnectedNames].filter((n) => n !== name),
      );
      this.emit("auto-disconnected", name);
    } catch (error) {
      this.emit(
        "auto-connect-error",
        name,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  // ── Shared connect logic ───────────────────────────────────

  private async _connectWithTracking(cs: DetectedCodespace): Promise<void> {
    try {
      await this._deps.connectCodespace(cs.name);
      this._autoConnectedNames = new Set([
        ...this._autoConnectedNames,
        cs.name,
      ]);
      this.emit("auto-connected", cs);
    } catch (error) {
      this.emit(
        "auto-connect-error",
        cs.name,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}
