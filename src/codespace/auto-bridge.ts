import { VSCODE_AUTO_BRIDGE_GRACE_MS } from "../shared/constants";
import type { CodespaceManager } from "./codespace-manager";
import type { VsCodeCodespaceDetector } from "./vscode-detector";
import type { CodespaceInfo } from "./types";

export interface AutoBridgeOrchestratorOptions {
  graceMs?: number;
  getModel: () => string;
}

/**
 * Drives CodespaceManager from VsCodeCodespaceDetector signals.
 * - New names → connect with source="vscode-auto"
 * - Vanished names → disconnect after graceMs (cancelled if name returns)
 * - Manual connections are left alone.
 */
export class AutoBridgeOrchestrator {
  private readonly detector: VsCodeCodespaceDetector;
  private readonly manager: CodespaceManager;
  private readonly graceMs: number;
  private readonly getModel: () => string;

  private readonly pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlightConnects = new Set<string>();
  private listener: ((set: Map<string, CodespaceInfo>) => void) | null = null;
  private running = false;

  constructor(
    detector: VsCodeCodespaceDetector,
    manager: CodespaceManager,
    options: AutoBridgeOrchestratorOptions,
  ) {
    this.detector = detector;
    this.manager = manager;
    this.graceMs = options.graceMs ?? VSCODE_AUTO_BRIDGE_GRACE_MS;
    this.getModel = options.getModel;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.listener = (set) => {
      void this.handleChange(set);
    };
    this.detector.on("changed", this.listener);
    // Apply current state immediately.
    void this.handleChange(new Map(this.detector.getCurrent()));
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.listener) this.detector.off("changed", this.listener);
    this.listener = null;
    for (const timer of this.pendingDisconnects.values()) clearTimeout(timer);
    this.pendingDisconnects.clear();
  }

  /** Visible for tests. */
  getPendingDisconnects(): ReadonlyMap<string, ReturnType<typeof setTimeout>> {
    return this.pendingDisconnects;
  }

  private async handleChange(currentSet: Map<string, CodespaceInfo>): Promise<void> {
    const connections = this.manager.getConnections();
    const autoBridged = new Map(
      connections
        .filter((c) => c.source === "vscode-auto")
        .map((c) => [c.id, c] as const),
    );

    // Cancel pending disconnects for names still present.
    for (const name of currentSet.keys()) {
      const t = this.pendingDisconnects.get(name);
      if (t) {
        clearTimeout(t);
        this.pendingDisconnects.delete(name);
      }
    }

    // Schedule disconnects for vanished auto-bridged connections.
    for (const [name] of autoBridged) {
      if (currentSet.has(name)) continue;
      if (this.pendingDisconnects.has(name)) continue;
      const timer = setTimeout(() => {
        this.pendingDisconnects.delete(name);
        void this.manager.disconnect(name).catch((err) => {
          console.warn(`[AutoBridge] disconnect ${name} failed:`, err);
        });
      }, this.graceMs);
      // Don't keep the event loop alive just for the grace timer.
      if (typeof timer === "object" && timer && typeof (timer as { unref?: () => unknown }).unref === "function") {
        (timer as { unref: () => unknown }).unref();
      }
      this.pendingDisconnects.set(name, timer);
    }

    // Connect new names.
    //
    // We intentionally DO NOT treat connections in `error` state as
    // "existing" — otherwise a single failed SSH attempt at startup would
    // permanently block auto-bridge from ever retrying that codespace.
    // Real connections (connecting / connected / reconnecting / etc.) still
    // block, so we don't spawn duplicate tunnels.
    const blockingNames = new Set(
      connections
        .filter((c) => c.connectionState !== "error" && c.connectionState !== "available")
        .map((c) => c.id),
    );
    for (const [name, info] of currentSet) {
      if (blockingNames.has(name)) continue;
      if (this.inFlightConnects.has(name)) continue;
      this.inFlightConnects.add(name);

      // If a stale errored entry exists for this name, clean it up first so
      // CodespaceManager.connect doesn't refuse with "already connected".
      const stale = autoBridged.get(name);
      const cleanup =
        stale && stale.connectionState === "error"
          ? this.manager.disconnect(name).catch(() => {
              /* best-effort — proceed even if cleanup fails */
            })
          : Promise.resolve();

      const model = this.getModel();
      void cleanup
        .then(() => this.manager.connect(info, model, "vscode-auto"))
        .catch((err) => {
          console.warn(`[AutoBridge] connect ${name} failed:`, err);
        })
        .finally(() => {
          this.inFlightConnects.delete(name);
        });
    }
  }
}
