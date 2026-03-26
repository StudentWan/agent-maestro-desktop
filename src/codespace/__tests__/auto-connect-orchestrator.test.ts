import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { AutoConnectOrchestrator } from "../auto-connect-orchestrator";
import type { AutoConnectDeps } from "../auto-connect-orchestrator";
import type { DetectedCodespace, AutoConnectConfig } from "../types";
import { DEFAULT_AUTO_CONNECT_CONFIG } from "../types";

// ── Helpers ──────────────────────────────────────────────────────

function makeDetectedCodespace(
  name = "test-cs",
  overrides: Partial<DetectedCodespace> = {},
): DetectedCodespace {
  return {
    name,
    workspacePath: `/workspaces/${name}`,
    detectedAt: Date.now(),
    source: "vscode-storage",
    ...overrides,
  };
}

function createMockDetector(): EventEmitter & AutoConnectDeps["detector"] {
  const emitter = new EventEmitter();
  const originalRemoveAllListeners = emitter.removeAllListeners.bind(emitter);
  return Object.assign(emitter, {
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => void>(),
    isWatching: false,
    detectedCodespaces: [] as readonly DetectedCodespace[],
    removeAllListeners: vi
      .fn<(event?: string) => EventEmitter>()
      .mockImplementation((event?: string) => originalRemoveAllListeners(event)),
  });
}

function createMockDeps(
  detectorOverrides: Partial<AutoConnectDeps["detector"]> = {},
): { deps: AutoConnectDeps; detector: ReturnType<typeof createMockDetector> } {
  const detector = createMockDetector();
  Object.assign(detector, detectorOverrides);

  const deps: AutoConnectDeps = {
    detector,
    connectCodespace: vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined),
    disconnectCodespace: vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined),
    isCodespaceConnected: vi.fn<(name: string) => boolean>().mockReturnValue(false),
    checkCodespaceScope: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };

  return { deps, detector };
}

// ── Tests ────────────────────────────────────────────────────────

describe("AutoConnectOrchestrator", () => {
  let deps: AutoConnectDeps;
  let detector: ReturnType<typeof createMockDetector>;

  beforeEach(() => {
    vi.restoreAllMocks();
    const mocks = createMockDeps();
    deps = mocks.deps;
    detector = mocks.detector;
  });

  // ── Constructor ──────────────────────────────────────────────

  describe("constructor", () => {
    it("initializes with default config when no config provided", () => {
      const orchestrator = new AutoConnectOrchestrator(deps);
      const state = orchestrator.getState();

      expect(state.config).toEqual(DEFAULT_AUTO_CONNECT_CONFIG);
    });

    it("accepts partial config override", () => {
      const orchestrator = new AutoConnectOrchestrator(deps, {
        enabled: true,
        debounceMs: 3000,
      });
      const state = orchestrator.getState();

      expect(state.config.enabled).toBe(true);
      expect(state.config.debounceMs).toBe(3000);
      // Defaults preserved for unspecified fields
      expect(state.config.autoDisconnectOnClose).toBe(false);
      expect(state.config.pollingFallbackMs).toBe(10_000);
    });
  });

  // ── start / stop ─────────────────────────────────────────────

  describe("start/stop", () => {
    it("start() delegates to detector.start()", async () => {
      const orchestrator = new AutoConnectOrchestrator(deps);
      await orchestrator.start();

      expect(detector.start).toHaveBeenCalledOnce();
    });

    it("stop() delegates to detector.stop()", () => {
      const orchestrator = new AutoConnectOrchestrator(deps);
      orchestrator.stop();

      expect(detector.stop).toHaveBeenCalledOnce();
    });

    it("stop() removes event listeners from detector", async () => {
      const orchestrator = new AutoConnectOrchestrator(deps);
      await orchestrator.start();
      orchestrator.stop();

      expect(detector.removeAllListeners).toHaveBeenCalled();
    });
  });

  // ── On codespace-opened (enabled = true) ─────────────────────

  describe("on codespace-opened (enabled)", () => {
    it("auto-connects when scope is available", async () => {
      const orchestrator = new AutoConnectOrchestrator(deps, { enabled: true });
      await orchestrator.start();

      const cs = makeDetectedCodespace("my-cs");
      detector.emit("codespace-opened", cs);

      // Allow async handler to settle
      await vi.waitFor(() => {
        expect(deps.connectCodespace).toHaveBeenCalledWith("my-cs");
      });
    });

    it("emits auto-connected event on successful connect", async () => {
      const orchestrator = new AutoConnectOrchestrator(deps, { enabled: true });
      await orchestrator.start();

      const autoConnectedSpy = vi.fn();
      orchestrator.on("auto-connected", autoConnectedSpy);

      const cs = makeDetectedCodespace("my-cs");
      detector.emit("codespace-opened", cs);

      await vi.waitFor(() => {
        expect(autoConnectedSpy).toHaveBeenCalledWith(cs);
      });
    });

    it("emits scope-required when scope is missing", async () => {
      vi.mocked(deps.checkCodespaceScope).mockResolvedValue(false);
      const orchestrator = new AutoConnectOrchestrator(deps, { enabled: true });
      await orchestrator.start();

      const scopeRequiredSpy = vi.fn();
      orchestrator.on("scope-required", scopeRequiredSpy);

      const cs = makeDetectedCodespace("my-cs");
      detector.emit("codespace-opened", cs);

      await vi.waitFor(() => {
        expect(scopeRequiredSpy).toHaveBeenCalledWith(cs);
      });

      expect(deps.connectCodespace).not.toHaveBeenCalled();
    });

    it("adds to pendingScopeCodespaces when scope is missing", async () => {
      vi.mocked(deps.checkCodespaceScope).mockResolvedValue(false);
      const orchestrator = new AutoConnectOrchestrator(deps, { enabled: true });
      await orchestrator.start();

      const cs = makeDetectedCodespace("my-cs");
      detector.emit("codespace-opened", cs);

      await vi.waitFor(() => {
        const state = orchestrator.getState();
        expect(state.pendingScopeCodespaces).toContainEqual(cs);
      });
    });

    it("skips if codespace is already connected", async () => {
      vi.mocked(deps.isCodespaceConnected).mockReturnValue(true);
      const orchestrator = new AutoConnectOrchestrator(deps, { enabled: true });
      await orchestrator.start();

      const cs = makeDetectedCodespace("my-cs");
      detector.emit("codespace-opened", cs);

      // Give the async handler time to run (or not)
      await new Promise((r) => setTimeout(r, 50));

      expect(deps.connectCodespace).not.toHaveBeenCalled();
    });

    it("does not connect when config.enabled is false", async () => {
      const orchestrator = new AutoConnectOrchestrator(deps, { enabled: false });
      await orchestrator.start();

      const cs = makeDetectedCodespace("my-cs");
      detector.emit("codespace-opened", cs);

      await new Promise((r) => setTimeout(r, 50));

      expect(deps.connectCodespace).not.toHaveBeenCalled();
      expect(deps.checkCodespaceScope).not.toHaveBeenCalled();
    });

    it("emits auto-connect-error on connection failure", async () => {
      const error = new Error("tunnel failed");
      vi.mocked(deps.connectCodespace).mockRejectedValue(error);
      const orchestrator = new AutoConnectOrchestrator(deps, { enabled: true });
      await orchestrator.start();

      const errorSpy = vi.fn();
      orchestrator.on("auto-connect-error", errorSpy);

      const cs = makeDetectedCodespace("my-cs");
      detector.emit("codespace-opened", cs);

      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith("my-cs", error);
      });
    });
  });

  // ── On codespace-closed ──────────────────────────────────────

  describe("on codespace-closed", () => {
    it("auto-disconnects when autoDisconnectOnClose is true and was auto-connected", async () => {
      const orchestrator = new AutoConnectOrchestrator(deps, {
        enabled: true,
        autoDisconnectOnClose: true,
      });
      await orchestrator.start();

      // First, auto-connect a codespace
      const cs = makeDetectedCodespace("my-cs");
      detector.emit("codespace-opened", cs);

      await vi.waitFor(() => {
        expect(deps.connectCodespace).toHaveBeenCalledWith("my-cs");
      });

      // Now close it
      detector.emit("codespace-closed", cs);

      await vi.waitFor(() => {
        expect(deps.disconnectCodespace).toHaveBeenCalledWith("my-cs");
      });
    });

    it("emits auto-disconnected event", async () => {
      const orchestrator = new AutoConnectOrchestrator(deps, {
        enabled: true,
        autoDisconnectOnClose: true,
      });
      await orchestrator.start();

      const disconnectedSpy = vi.fn();
      orchestrator.on("auto-disconnected", disconnectedSpy);

      // Auto-connect first
      const cs = makeDetectedCodespace("my-cs");
      detector.emit("codespace-opened", cs);

      await vi.waitFor(() => {
        expect(deps.connectCodespace).toHaveBeenCalledWith("my-cs");
      });

      // Close
      detector.emit("codespace-closed", cs);

      await vi.waitFor(() => {
        expect(disconnectedSpy).toHaveBeenCalledWith("my-cs");
      });
    });

    it("does NOT disconnect manually-connected codespace", async () => {
      const orchestrator = new AutoConnectOrchestrator(deps, {
        enabled: true,
        autoDisconnectOnClose: true,
      });
      await orchestrator.start();

      // Close a codespace that was NOT auto-connected
      const cs = makeDetectedCodespace("manual-cs");
      detector.emit("codespace-closed", cs);

      await new Promise((r) => setTimeout(r, 50));

      expect(deps.disconnectCodespace).not.toHaveBeenCalled();
    });

    it("does NOT disconnect when autoDisconnectOnClose is false", async () => {
      const orchestrator = new AutoConnectOrchestrator(deps, {
        enabled: true,
        autoDisconnectOnClose: false,
      });
      await orchestrator.start();

      // Auto-connect first
      const cs = makeDetectedCodespace("my-cs");
      detector.emit("codespace-opened", cs);

      await vi.waitFor(() => {
        expect(deps.connectCodespace).toHaveBeenCalledWith("my-cs");
      });

      // Close
      detector.emit("codespace-closed", cs);

      await new Promise((r) => setTimeout(r, 50));

      expect(deps.disconnectCodespace).not.toHaveBeenCalled();
    });
  });

  // ── updateConfig ─────────────────────────────────────────────

  describe("updateConfig", () => {
    it("returns new config with partial updates (immutable)", () => {
      const orchestrator = new AutoConnectOrchestrator(deps);
      const original = orchestrator.getState().config;

      const updated = orchestrator.updateConfig({ enabled: true });

      expect(updated.enabled).toBe(true);
      expect(updated.debounceMs).toBe(DEFAULT_AUTO_CONNECT_CONFIG.debounceMs);
      // Original should be untouched
      expect(original.enabled).toBe(false);
    });

    it("does not mutate existing config", () => {
      const orchestrator = new AutoConnectOrchestrator(deps);
      const before = orchestrator.getState().config;

      orchestrator.updateConfig({ enabled: true, debounceMs: 5000 });

      // The original config reference must not have changed
      expect(before.enabled).toBe(false);
      expect(before.debounceMs).toBe(1500);

      // But getState() returns the new config
      const after = orchestrator.getState().config;
      expect(after.enabled).toBe(true);
      expect(after.debounceMs).toBe(5000);
    });
  });

  // ── retryPendingConnections ──────────────────────────────────

  describe("retryPendingConnections", () => {
    it("connects pending codespaces when scope becomes available", async () => {
      // Initially no scope
      vi.mocked(deps.checkCodespaceScope).mockResolvedValue(false);
      const orchestrator = new AutoConnectOrchestrator(deps, { enabled: true });
      await orchestrator.start();

      // Detect two codespaces — both go to pending
      const cs1 = makeDetectedCodespace("cs-1");
      const cs2 = makeDetectedCodespace("cs-2");
      detector.emit("codespace-opened", cs1);
      detector.emit("codespace-opened", cs2);

      await vi.waitFor(() => {
        expect(orchestrator.getState().pendingScopeCodespaces).toHaveLength(2);
      });

      // Now scope becomes available
      vi.mocked(deps.checkCodespaceScope).mockResolvedValue(true);
      await orchestrator.retryPendingConnections();

      expect(deps.connectCodespace).toHaveBeenCalledWith("cs-1");
      expect(deps.connectCodespace).toHaveBeenCalledWith("cs-2");
    });

    it("clears pending list after successful retry", async () => {
      vi.mocked(deps.checkCodespaceScope).mockResolvedValue(false);
      const orchestrator = new AutoConnectOrchestrator(deps, { enabled: true });
      await orchestrator.start();

      const cs = makeDetectedCodespace("pending-cs");
      detector.emit("codespace-opened", cs);

      await vi.waitFor(() => {
        expect(orchestrator.getState().pendingScopeCodespaces).toHaveLength(1);
      });

      // Retry with scope available
      vi.mocked(deps.checkCodespaceScope).mockResolvedValue(true);
      await orchestrator.retryPendingConnections();

      expect(orchestrator.getState().pendingScopeCodespaces).toHaveLength(0);
    });

    it("keeps pending list if scope still missing", async () => {
      vi.mocked(deps.checkCodespaceScope).mockResolvedValue(false);
      const orchestrator = new AutoConnectOrchestrator(deps, { enabled: true });
      await orchestrator.start();

      const cs = makeDetectedCodespace("pending-cs");
      detector.emit("codespace-opened", cs);

      await vi.waitFor(() => {
        expect(orchestrator.getState().pendingScopeCodespaces).toHaveLength(1);
      });

      // Retry — still no scope
      await orchestrator.retryPendingConnections();

      expect(orchestrator.getState().pendingScopeCodespaces).toHaveLength(1);
      expect(deps.connectCodespace).not.toHaveBeenCalled();
    });
  });

  // ── getState ─────────────────────────────────────────────────

  describe("getState", () => {
    it("returns correct state snapshot", async () => {
      const cs = makeDetectedCodespace("detected-cs");
      const detectorWithState = createMockDetector();
      Object.defineProperty(detectorWithState, "isWatching", { value: true });
      Object.defineProperty(detectorWithState, "detectedCodespaces", {
        value: [cs],
      });

      const { deps: depsWithState } = createMockDeps();
      const customDeps: AutoConnectDeps = {
        ...depsWithState,
        detector: detectorWithState,
      };

      const orchestrator = new AutoConnectOrchestrator(customDeps, {
        enabled: true,
        autoDisconnectOnClose: true,
      });

      const state = orchestrator.getState();

      expect(state.isWatching).toBe(true);
      expect(state.config.enabled).toBe(true);
      expect(state.config.autoDisconnectOnClose).toBe(true);
      expect(state.detectedCodespaces).toEqual([cs]);
      expect(state.pendingScopeCodespaces).toEqual([]);
    });
  });
});
