import { VSCODE_AUTO_BRIDGE_GRACE_MS } from "../shared/constants";
import type { AgentModelMap, AgentModelOptionsMap, CodespaceManager } from "./codespace-manager";
import type { VsCodeCodespaceDetector } from "./vscode-detector";
import type { CodespaceInfo } from "./types";

export interface AutoBridgeOrchestratorOptions {
  graceMs?: number;
  /**
   * Snapshot of "what model is selected per agent right now". Called at
   * connect-time so each codespace is configured for every registered
   * agent simultaneously.
   */
  getAgentModels: () => AgentModelMap;
  /**
   * Optional snapshot of per-agent extras (e.g. cached
   * `max_prompt_tokens`) recorded at model selection time. When provided,
   * connect() stamps Codex's `model_context_window` so the remote CLI
   * compacts before bodies exceed Copilot's 413 ceiling. Optional so
   * legacy bootstrap paths keep working.
   */
  getAgentModelOptions?: () => AgentModelOptionsMap;
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
  private readonly getAgentModels: () => AgentModelMap;
  private readonly getAgentModelOptions: () => AgentModelOptionsMap;

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
    this.getAgentModels = options.getAgentModels;
    this.getAgentModelOptions = options.getAgentModelOptions ?? (() => ({}));
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

        // Race guard: if the connection is currently in `reconnecting`, the
        // manager is actively trying to recover from a tunnel drop. Calling
        // disconnect() here would cancel that recovery — exactly the wrong
        // outcome. Skip; if VS Code is really gone, the next tick will see
        // the entry in a different state and retry the grace timer.
        const conn = this.manager.getConnection(name);
        if (conn?.connectionState === "reconnecting") {
          console.log(
            `[${new Date().toISOString()}] [AutoBridge] grace expired for ${name} but connection is reconnecting — skipping disconnect to avoid racing recovery`,
          );
          return;
        }

        // Second-look guard: a single missed tick can be a transient
        // detector blip (PowerShell hiccup, VS Code briefly without a
        // [Codespaces:] title because Output panel grabbed focus, codespace
        // momentarily reported as Updating). Re-check the detector's
        // current snapshot; if it now sees the codespace again, abandon
        // this disconnect — VS Code never actually went away.
        if (this.detector.getCurrent().has(name)) {
          console.log(
            `[${new Date().toISOString()}] [AutoBridge] grace expired for ${name} but detector now sees it again — abandoning disconnect (likely transient detector miss)`,
          );
          return;
        }

        // Health-trumps-detection guard: if the connection is still
        // `connected` after the grace window, the SSH tunnel is alive and
        // the proxy is working. Detector saying "VS Code is gone" while the
        // tunnel is still healthy is more often a detector false-negative
        // than the user actually closing VS Code. Skip this round; if it
        // really is gone the next tick will keep currentSet empty and the
        // next grace cycle will get another chance.
        if (conn?.connectionState === "connected") {
          console.log(
            `[${new Date().toISOString()}] [AutoBridge] grace expired for ${name} but connection is healthy (state=connected) — deferring disconnect, will re-evaluate on next detector tick`,
          );
          return;
        }

        console.log(
          `[${new Date().toISOString()}] [AutoBridge] grace expired for ${name} (state=${conn?.connectionState ?? "missing"}) — disconnecting`,
        );
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

      const models = this.getAgentModels();
      const modelOptions = this.getAgentModelOptions();
      void cleanup
        .then(() => this.manager.connect(info, models, modelOptions, "vscode-auto"))
        .catch((err) => {
          console.warn(`[AutoBridge] connect ${name} failed:`, err);
        })
        .finally(() => {
          this.inFlightConnects.delete(name);
        });
    }
  }
}
