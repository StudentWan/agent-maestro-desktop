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
  getConnection(name: string) {
    return this.connections.find((c) => c.id === name);
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

  it("does NOT disconnect a healthy `connected` entry when detection blips (defers instead)", async () => {
    // Regression for the "[AutoBridge] grace expired ... (state=connected) —
    // disconnecting" log we saw in the wild: detector momentarily lost the
    // codespace (PowerShell hiccup, or VS Code title temporarily without
    // [Codespaces:] tag), grace timer fired, and a perfectly healthy
    // connection got torn down. Now grace expiry on a `connected` entry is
    // deferred — only really-gone (state != connected) entries get the
    // disconnect.
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

    // Detector still sees nothing; grace timer fires.
    await vi.advanceTimersByTimeAsync(5001);

    // Connection is `connected`, so disconnect MUST be deferred. The user
    // never closed VS Code — we just blinked.
    expect(mgr.disconnectMock).not.toHaveBeenCalled();
  });

  it("disconnects a non-connected entry when grace expires (e.g. connection still in connecting phase)", async () => {
    // The flip side of the previous test: only `connected` entries get the
    // "defer disconnect" treatment. Entries in transient states still get
    // cleaned up when grace expires so we don't leak placeholder rows.
    const det = new FakeDetector();
    const mgr = new FakeManager();
    const conn = makeConn("foo-bar-baz-q", "vscode-auto");
    // `connecting` is a transient state autoBridge treats as "blocking"
    // (won't try to reconnect), so the orchestrator sees the entry on
    // startup but doesn't race with a stale-error cleanup.
    conn.connectionState = "connecting";
    mgr.connections.push(conn);
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

  it("does NOT race-disconnect a connection that is currently reconnecting", async () => {
    // Regression: the manager's handleUnexpectedDisconnect kicks in when the
    // SSH tunnel dies and walks the connection through "reconnecting → ...
    // → connected". If VS Code's window title also briefly disappeared at
    // the same time (extension reload, worker restart), the orchestrator's
    // grace timer would fire and call disconnect(), tearing down the
    // recovery in progress. Now the timer skips the call when state is
    // "reconnecting".
    const det = new FakeDetector();
    const mgr = new FakeManager();
    const conn = makeConn("foo-bar-baz-q", "vscode-auto");
    mgr.connections.push(conn);
    det.current = new Map([["foo-bar-baz-q", csInfo("foo-bar-baz-q")]]);

    const orch = new AutoBridgeOrchestrator(
      det as never,
      mgr as never,
      { graceMs: 5000, getModel: () => "m" },
    );
    orch.start();
    await Promise.resolve();

    // Codespace appears to vanish from VS Code → grace timer scheduled.
    det.emitSet(new Map());
    await Promise.resolve();
    expect(orch.getPendingDisconnects().has("foo-bar-baz-q")).toBe(true);

    // Manager has, in parallel, decided it's reconnecting.
    conn.connectionState = "reconnecting";

    // Grace expires.
    await vi.advanceTimersByTimeAsync(5001);

    // disconnect must NOT have been called — that would have killed the
    // in-flight reconnect.
    expect(mgr.disconnectMock).not.toHaveBeenCalled();
  });
});
