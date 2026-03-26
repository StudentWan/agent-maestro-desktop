// src/codespace/vscode-detector.ts

import { EventEmitter } from "node:events";
import type {
  DetectedCodespace,
  VscodeDetectorDeps,
  AutoConnectConfig,
} from "./types";
import {
  parseStorageJson,
  extractCodespaces,
  diffCodespaces,
} from "./vscode-storage-parser";

export class VscodeDetector extends EventEmitter {
  private _isWatching = false;
  private _currentCodespaces: readonly DetectedCodespace[] = [];
  private _watcher: { close: () => void } | null = null;
  private _pollingTimer: ReturnType<typeof setInterval> | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _deps: VscodeDetectorDeps;
  private readonly _debounceMs: number;
  private readonly _pollingFallbackMs: number;

  constructor(deps: VscodeDetectorDeps, config?: Partial<AutoConnectConfig>) {
    super();
    this._deps = deps;
    this._debounceMs = config?.debounceMs ?? 1500;
    this._pollingFallbackMs = config?.pollingFallbackMs ?? 10_000;
  }

  /** Start watching storage.json. No-op if already watching or storagePath is null. */
  async start(): Promise<void> {
    if (this._isWatching || !this._deps.storagePath) {
      return;
    }

    this._isWatching = true;

    // Initial read — swallow errors (file may not exist yet)
    await this._readAndDiff().catch(() => {
      // Intentionally ignored during startup
    });

    // Set up fs.watch if file exists
    const exists = await this._deps.fileExists(this._deps.storagePath);
    if (exists) {
      this._setupWatcher();
    }

    // Set up polling fallback
    this._pollingTimer = setInterval(() => {
      this._readAndDiff().catch((err: unknown) => {
        this.emit(
          "detection-error",
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    }, this._pollingFallbackMs);

    this.emit("watcher-started");
  }

  /** Stop watching, clear all timers, reset state. */
  stop(): void {
    if (!this._isWatching) {
      return;
    }

    this._isWatching = false;
    this._watcher?.close();
    this._watcher = null;

    if (this._pollingTimer) {
      clearInterval(this._pollingTimer);
      this._pollingTimer = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    this._currentCodespaces = [];
    this.emit("watcher-stopped");
  }

  get isWatching(): boolean {
    return this._isWatching;
  }

  get detectedCodespaces(): readonly DetectedCodespace[] {
    return this._currentCodespaces;
  }

  /** Force an immediate re-read of storage.json. */
  async refresh(): Promise<readonly DetectedCodespace[]> {
    await this._readAndDiff();
    return this._currentCodespaces;
  }

  private _setupWatcher(): void {
    if (!this._deps.storagePath) {
      return;
    }

    try {
      this._watcher = this._deps.watchFile(
        this._deps.storagePath,
        () => {
          this._scheduleRead();
        },
      );
    } catch (err: unknown) {
      this.emit(
        "detection-error",
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /** Debounce reads to avoid excessive parsing during rapid VS Code writes. */
  private _scheduleRead(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._readAndDiff().catch((err: unknown) => {
        this.emit(
          "detection-error",
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    }, this._debounceMs);
  }

  /** Read storage.json, parse, diff against current state, emit events. */
  private async _readAndDiff(): Promise<void> {
    if (!this._deps.storagePath) {
      return;
    }

    let raw: string;
    try {
      raw = await this._deps.readFile(this._deps.storagePath);
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    const storage = parseStorageJson(raw);
    if (!storage) {
      return;
    }

    const newCodespaces = extractCodespaces(storage);
    const diff = diffCodespaces(this._currentCodespaces, newCodespaces);

    // Replace state immutably
    this._currentCodespaces = newCodespaces;

    // Emit events for changes
    for (const cs of diff.opened) {
      this.emit("codespace-opened", cs);
    }
    for (const cs of diff.closed) {
      this.emit("codespace-closed", cs);
    }
  }
}
