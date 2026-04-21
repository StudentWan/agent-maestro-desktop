import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { AutoBridgeOrchestrator } from "../auto-bridge";
import type { CodespaceInfo, CodespaceConnection, CodespaceConnectionSource } from "../types";

function csInfo(name: string): CodespaceInfo {
  return {
    id: 1,
    name,
    displayName: name,
    repository: "user/repo",
    state: "Available",
    machine: "4-core",
    lastUsedAt: "2026-04-20T00:00:00Z",
  };
}

function makeConn(name: string, source: CodespaceConnectionSource): CodespaceConnection {
  return {
    id: name,
    info: csInfo(name),
    connectionState: "connected",
    remotePort: 23337,
    localPort: 23337,
    connectedAt: Date.now(),
    lastHealthCheck: null,
    reconnectAttempts: 0,
    source,
  };
}

class FakeDetector extends EventEmitter {
  current = new Map<string, CodespaceInfo>();
  getCurrent() {
    return this.current;
  }
  emitSet(set: Map<string, CodespaceInfo>) {
    this.current = set;
    this.emit("changed", new Map(set));
  }
}

class FakeManager {
  connections: CodespaceConnection[] = [];
  connectMock = vi.fn(
    async (info: CodespaceInfo, _model: string, source: CodespaceConnectionSource = "manual") => {
      const c = makeConn(info.name, source);
      this.connections.push(c);
      return c;
    },
  );
  disconnectMock = vi.fn(async (name: string) => {
    this.connections = this.connections.filter((c) => c.id !== name);
  });
  connect(info: CodespaceInfo, model: string, source?: CodespaceConnectionSource) {
    return this.connectMock(info, model, source);
  }
  disconnect(name: string) {
    return this.disconnectMock(name);
  }
  getConnections() {
    return this.connections.slice();
  }
}

describe("AutoBridgeOrchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects new codespaces detected by VS Code with source=vscode-auto", async () => {
    const det = new FakeDetector();
    const mgr = new FakeManager();
    const orch = new AutoBridgeOrchestrator(
      det as never,
      mgr as never,
      { graceMs: 1000, getModel: () => "claude-opus-4.6" },
    );
    orch.start();

    det.emitSet(new Map([["foo-bar-baz-q", csInfo("foo-bar-baz-q")]]));
    await vi.runAllTicks();
    await Promise.resolve();

    expect(mgr.connectMock).toHaveBeenCalledTimes(1);
    expect(mgr.connectMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "foo-bar-baz-q" }),
      "claude-opus-4.6",
      "vscode-auto",
    );
  });

  it("schedules disconnect after graceMs when codespace vanishes", async () => {
    const det = new FakeDetector();
    const mgr = new FakeManager();
    mgr.connections.push(makeConn("foo-bar-baz-q", "vscode-auto"));
    det.current = new Map([["foo-bar-baz-q", csInfo("foo-bar-baz-q")]]);

    const orch = new AutoBridgeOrchestrator(
      det as never,
      mgr as never,
      { graceMs: 5000, getModel: () => "m" },
    );
    orch.start();
    await Promise.resolve();
    expect(mgr.disconnectMock).not.toHaveBeenCalled();

    det.emitSet(new Map());
    await Promise.resolve();
    expect(orch.getPendingDisconnects().has("foo-bar-baz-q")).toBe(true);
    expect(mgr.disconnectMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5001);
    expect(mgr.disconnectMock).toHaveBeenCalledWith("foo-bar-baz-q");
  });

  it("cancels pending disconnect if codespace reappears within grace", async () => {
    const det = new FakeDetector();
    const mgr = new FakeManager();
    mgr.connections.push(makeConn("foo-bar-baz-q", "vscode-auto"));
    det.current = new Map([["foo-bar-baz-q", csInfo("foo-bar-baz-q")]]);

    const orch = new AutoBridgeOrchestrator(
      det as never,
      mgr as never,
      { graceMs: 5000, getModel: () => "m" },
    );
    orch.start();
    await Promise.resolve();

    det.emitSet(new Map());
    await Promise.resolve();
    expect(orch.getPendingDisconnects().has("foo-bar-baz-q")).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);
    det.emitSet(new Map([["foo-bar-baz-q", csInfo("foo-bar-baz-q")]]));
    await Promise.resolve();
    expect(orch.getPendingDisconnects().has("foo-bar-baz-q")).toBe(false);

    await vi.advanceTimersByTimeAsync(10000);
    expect(mgr.disconnectMock).not.toHaveBeenCalled();
  });

  it("does not connect if a connection already exists for the same name", async () => {
    const det = new FakeDetector();
    const mgr = new FakeManager();
    mgr.connections.push(makeConn("foo-bar-baz-q", "vscode-auto"));
    const orch = new AutoBridgeOrchestrator(
      det as never,
      mgr as never,
      { graceMs: 1000, getModel: () => "m" },
    );
    orch.start();

    det.emitSet(new Map([["foo-bar-baz-q", csInfo("foo-bar-baz-q")]]));
    await Promise.resolve();
    expect(mgr.connectMock).not.toHaveBeenCalled();
  });

  it("ignores manual connections when scheduling disconnects", async () => {
    const det = new FakeDetector();
    const mgr = new FakeManager();
    mgr.connections.push(makeConn("manual-cs", "manual"));
    det.current = new Map();

    const orch = new AutoBridgeOrchestrator(
      det as never,
      mgr as never,
      { graceMs: 1000, getModel: () => "m" },
    );
    orch.start();
    await Promise.resolve();
    det.emitSet(new Map());
    await Promise.resolve();

    expect(orch.getPendingDisconnects().has("manual-cs")).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(mgr.disconnectMock).not.toHaveBeenCalled();
  });

  it("stop() clears pending timers and detaches listener", async () => {
    const det = new FakeDetector();
    const mgr = new FakeManager();
    mgr.connections.push(makeConn("foo-bar-baz-q", "vscode-auto"));
    det.current = new Map([["foo-bar-baz-q", csInfo("foo-bar-baz-q")]]);

    const orch = new AutoBridgeOrchestrator(
      det as never,
      mgr as never,
      { graceMs: 5000, getModel: () => "m" },
    );
    orch.start();
    await Promise.resolve();

    det.emitSet(new Map());
    await Promise.resolve();
    expect(orch.getPendingDisconnects().size).toBe(1);

    orch.stop();
    expect(orch.getPendingDisconnects().size).toBe(0);

    await vi.advanceTimersByTimeAsync(10000);
    expect(mgr.disconnectMock).not.toHaveBeenCalled();

    // After stop, further detector events should be ignored
    det.emitSet(new Map([["other-cs", csInfo("other-cs")]]));
    await Promise.resolve();
    expect(mgr.connectMock).not.toHaveBeenCalled();
  });

  it("retries connect when a stale errored entry exists for the same name", async () => {
    const det = new FakeDetector();
    const mgr = new FakeManager();
    // Simulate a previous auto-bridge attempt that failed (e.g., SSH tunnel
    // couldn't bind a port). Without the fix, this entry permanently blocks
    // further connect attempts.
    const errored = makeConn("foo-bar-baz-q", "vscode-auto");
    errored.connectionState = "error";
    errored.errorMessage = "SSH tunnel failed";
    mgr.connections.push(errored);

    const orch = new AutoBridgeOrchestrator(
      det as never,
      mgr as never,
      { graceMs: 1000, getModel: () => "m" },
    );
    orch.start();

    det.emitSet(new Map([["foo-bar-baz-q", csInfo("foo-bar-baz-q")]]));
    // Drain microtasks so cleanup → reconnect chain resolves.
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();

    expect(mgr.disconnectMock).toHaveBeenCalledWith("foo-bar-baz-q");
    expect(mgr.connectMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "foo-bar-baz-q" }),
      "m",
      "vscode-auto",
    );
  });
});
