import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodespaceManager } from "../codespace-manager";

// Mock dependencies
vi.mock("../gh-cli", () => ({
  listCodespaces: vi.fn(),
  executeRemoteCommand: vi.fn(),
  spawnSshTunnel: vi.fn(),
  startCodespace: vi.fn(),
}));

vi.mock("../ssh-tunnel", () => {
  const { EventEmitter } = require("node:events");
  return {
    SshTunnel: vi.fn().mockImplementation(() => {
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      tunnel.codespaceName = "test-codespace";
      tunnel.remotePort = 23337;
      tunnel.localPort = 23337;
      return tunnel;
    }),
  };
});

import { listCodespaces, executeRemoteCommand } from "../gh-cli";

describe("CodespaceManager", () => {
  beforeEach(() => {
    vi.mocked(listCodespaces).mockReset();
    vi.mocked(executeRemoteCommand).mockReset();
  });

  it("allocates ports starting from base port", () => {
    const manager = new CodespaceManager(23337);
    const port1 = manager.allocatePort();
    const port2 = manager.allocatePort();
    expect(port1).toBe(23337);
    expect(port2).toBe(23338);
  });

  it("frees and reuses ports", () => {
    const manager = new CodespaceManager(23337);
    const port1 = manager.allocatePort();
    manager.freePort(port1);
    const port2 = manager.allocatePort();
    expect(port2).toBe(23337);
  });

  it("lists codespaces via gh CLI", async () => {
    vi.mocked(listCodespaces).mockResolvedValue([
      {
        id: 1,
        name: "test-cs",
        displayName: "test-cs",
        repository: "user/repo",
        state: "Available",
        machine: "4-core",
        lastUsedAt: "2026-03-24T10:00:00Z",
      },
    ]);

    const manager = new CodespaceManager(23337);
    const list = await manager.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("test-cs");
  });

  it("returns empty connections initially", () => {
    const manager = new CodespaceManager(23337);
    const connections = manager.getConnections();
    expect(connections).toEqual([]);
  });

  it("kills all tunnels synchronously", () => {
    const manager = new CodespaceManager(23337);
    // Should not throw even with no connections
    manager.killAllTunnels();
    expect(manager.getConnections()).toEqual([]);
  });

  it("does NOT reconnect when codespace is no longer Available (user stopped it)", async () => {
    // This is the regression test for the "auto-bridge resurrects stopped
    // codespace" bug. When the SSH tunnel exits because the user stopped
    // the codespace, the manager must check `gh cs list` first and abort
    // reconnect if state != Available — otherwise `gh codespace ssh` will
    // happily auto-start the codespace again.

    const { SshTunnel } = await import("../ssh-tunnel");
    const SshTunnelMock = SshTunnel as unknown as ReturnType<typeof vi.fn>;
    const tunnelInstances: any[] = [];
    SshTunnelMock.mockImplementation(function () {
      const { EventEmitter } = require("node:events");
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      tunnel.codespaceName = "test-cs";
      tunnel.remotePort = 23337;
      tunnel.localPort = 23337;
      tunnelInstances.push(tunnel);
      return tunnel;
    });

    const csInfo = {
      id: 1,
      name: "test-cs",
      displayName: "test-cs",
      repository: "user/repo",
      state: "Available",
      machine: "4-core",
      lastUsedAt: "2026-04-20T00:00:00Z",
    };

    vi.mocked(listCodespaces).mockResolvedValue([{ ...csInfo, state: "Shutdown" }]);
    vi.mocked(executeRemoteCommand).mockResolvedValue("1\n");

    const manager = new CodespaceManager(23337, () => "test-token");
    const events: any[] = [];
    manager.on("connectionChanged", (c) => events.push(c));

    await manager.connect(csInfo, "claude-opus");
    expect(tunnelInstances).toHaveLength(1);

    // Simulate the SSH tunnel dying because user stopped the codespace.
    tunnelInstances[0].emit("unexpectedExit", 255);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(tunnelInstances).toHaveLength(1);
    // New contract: instead of silently deleting the entry (UI loses the row
    // with no explanation), keep it in `error / codespace-unavailable` so the
    // user can see why and choose Reconnect or Dismiss. Auto-reconnect is
    // still skipped — that part is the safety property we mustn't regress.
    const conns = manager.getConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0].connectionState).toBe("error");
    expect(conns[0].errorCode).toBe("codespace-unavailable");
    const lastConn = events[events.length - 1];
    expect(lastConn.connectionState).toBe("error");
  });

  it("does NOT reconnect when state check fails (be conservative)", async () => {
    const { SshTunnel } = await import("../ssh-tunnel");
    const SshTunnelMock = SshTunnel as unknown as ReturnType<typeof vi.fn>;
    const tunnelInstances: any[] = [];
    SshTunnelMock.mockImplementation(function () {
      const { EventEmitter } = require("node:events");
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      tunnel.codespaceName = "test-cs";
      tunnel.remotePort = 23337;
      tunnel.localPort = 23337;
      tunnelInstances.push(tunnel);
      return tunnel;
    });

    const csInfo = {
      id: 1,
      name: "test-cs",
      displayName: "test-cs",
      repository: "user/repo",
      state: "Available",
      machine: "4-core",
      lastUsedAt: "2026-04-20T00:00:00Z",
    };

    vi.mocked(listCodespaces).mockRejectedValue(new Error("API down"));
    vi.mocked(executeRemoteCommand).mockResolvedValue("1\n");

    const manager = new CodespaceManager(23337, () => "test-token");
    await manager.connect(csInfo, "claude-opus");

    tunnelInstances[0].emit("unexpectedExit", 255);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(tunnelInstances).toHaveLength(1);
    // Same new contract as the previous test: keep the entry visible in
    // error state, but distinguish the cause — here the API itself failed
    // so the errorCode is `state-check-failed` rather than
    // `codespace-unavailable`. Either way auto-reconnect is skipped.
    const conns = manager.getConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0].connectionState).toBe("error");
    expect(conns[0].errorCode).toBe("state-check-failed");
  });

  it("connect() tears down when remote-config write never verifies (user not misled)", async () => {
    const { SshTunnel } = await import("../ssh-tunnel");
    const SshTunnelMock = SshTunnel as unknown as ReturnType<typeof vi.fn>;
    const tunnelInstances: any[] = [];
    SshTunnelMock.mockImplementation(function () {
      const { EventEmitter } = require("node:events");
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      tunnelInstances.push(tunnel);
      return tunnel;
    });

    const csInfo = {
      id: 1, name: "test-cs", displayName: "test-cs",
      repository: "user/repo", state: "Available",
      machine: "4-core", lastUsedAt: "2026-04-20T00:00:00Z",
    };
    // Verify-grep always returns "0" — marker never lands → retries exhausted.
    vi.mocked(executeRemoteCommand).mockResolvedValue("0\n");

    const manager = new CodespaceManager(23337, () => "tok");
    await expect(manager.connect(csInfo, "claude-opus")).rejects.toThrow(
      /Remote config/i,
    );
    // Tunnel must have been torn down — leaving it would mislead the UI.
    expect(tunnelInstances[0].disconnect).toHaveBeenCalled();
    // Error entry stays in the map so the UI can show Reconnect/Dismiss
    // (without this, refresh() would drop the row and the bare "Connect"
    // button would re-appear — the very race we wanted to avoid).
    const conns = manager.getConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0].connectionState).toBe("error");
    expect(conns[0].errorCode).toBe("remote-config-failed");
  }, 30_000);

  it("connect() succeeds on retry when first attempt does not verify", async () => {
    const { SshTunnel } = await import("../ssh-tunnel");
    const SshTunnelMock = SshTunnel as unknown as ReturnType<typeof vi.fn>;
    SshTunnelMock.mockImplementation(function () {
      const { EventEmitter } = require("node:events");
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      return tunnel;
    });

    const csInfo = {
      id: 1, name: "test-cs", displayName: "test-cs",
      repository: "user/repo", state: "Available",
      machine: "4-core", lastUsedAt: "2026-04-20T00:00:00Z",
    };
    vi.mocked(executeRemoteCommand)
      .mockResolvedValueOnce("")     // attempt 1: write
      .mockResolvedValueOnce("")     // attempt 1: onboarding
      .mockResolvedValueOnce("0\n")  // attempt 1: verify → not yet
      .mockResolvedValueOnce("")     // attempt 2: write
      .mockResolvedValueOnce("")     // attempt 2: onboarding
      .mockResolvedValueOnce("1\n"); // attempt 2: verify → ok

    const manager = new CodespaceManager(23337, () => "tok");
    const result = await manager.connect(csInfo, "claude-opus");
    expect(result.connectionState).toBe("connected");
  }, 30_000);

  it("disconnect() skips remote cleanup when codespace is no longer Available (no resurrection)", async () => {
    const { SshTunnel } = await import("../ssh-tunnel");
    const SshTunnelMock = SshTunnel as unknown as ReturnType<typeof vi.fn>;
    SshTunnelMock.mockImplementation(function () {
      const { EventEmitter } = require("node:events");
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      return tunnel;
    });

    const csInfo = {
      id: 1, name: "test-cs", displayName: "test-cs",
      repository: "user/repo", state: "Available",
      machine: "4-core", lastUsedAt: "2026-04-20T00:00:00Z",
    };
    vi.mocked(listCodespaces).mockResolvedValue([{ ...csInfo, state: "Shutdown" }]);
    vi.mocked(executeRemoteCommand).mockResolvedValue("1\n");

    const manager = new CodespaceManager(23337, () => "tok");
    await manager.connect(csInfo, "claude-opus");

    vi.mocked(executeRemoteCommand).mockClear();
    await manager.disconnect("test-cs");

    // The cleanup `gh codespace ssh -- ...` MUST NOT have been called —
    // it would have resurrected the stopped codespace.
    expect(executeRemoteCommand).not.toHaveBeenCalled();
    expect(manager.getConnections()).toEqual([]);
  });

  it("getConnections() includes the in-flight entry while connect() is still running", async () => {
    // Regression: previously the manager only added the entry to its map
    // at the end of connect(). A refresh() race during the SSH/config
    // phase would call getConnections() and get [], wiping the row in
    // the UI and briefly re-showing the bare "Connect" button.
    const { SshTunnel } = await import("../ssh-tunnel");
    const SshTunnelMock = SshTunnel as unknown as ReturnType<typeof vi.fn>;
    let resolveTunnelConnect: (() => void) | null = null;
    SshTunnelMock.mockImplementation(function () {
      const { EventEmitter } = require("node:events");
      const tunnel = new EventEmitter();
      // Block tunnel.connect() so the test can poke getConnections()
      // while connect() is still in-flight.
      tunnel.connect = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveTunnelConnect = resolve;
          }),
      );
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      return tunnel;
    });

    const csInfo = {
      id: 1, name: "test-cs", displayName: "test-cs",
      repository: "user/repo", state: "Available",
      machine: "4-core", lastUsedAt: "2026-04-20T00:00:00Z",
    };
    vi.mocked(executeRemoteCommand).mockResolvedValue("1\n");

    const manager = new CodespaceManager(23337, () => "tok");
    const connectPromise = manager.connect(csInfo, "claude-opus");

    // Yield once so the synchronous registration in connect() runs.
    await new Promise((r) => setTimeout(r, 0));

    const midFlight = manager.getConnections();
    expect(midFlight).toHaveLength(1);
    expect(midFlight[0].connectionState).toBe("connecting");
    expect(midFlight[0].id).toBe("test-cs");

    // Let connect() finish so we don't leak a hanging promise.
    (resolveTunnelConnect as unknown as () => void)?.();
    await connectPromise;
  });

  it("emits progress phases in order during connect()", async () => {
    const { SshTunnel } = await import("../ssh-tunnel");
    const SshTunnelMock = SshTunnel as unknown as ReturnType<typeof vi.fn>;
    SshTunnelMock.mockImplementation(function () {
      const { EventEmitter } = require("node:events");
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      return tunnel;
    });

    const csInfo = {
      id: 1, name: "test-cs", displayName: "test-cs",
      repository: "user/repo", state: "Available",
      machine: "4-core", lastUsedAt: "2026-04-20T00:00:00Z",
    };
    vi.mocked(executeRemoteCommand).mockResolvedValue("1\n");

    const manager = new CodespaceManager(23337, () => "tok");
    const phases: (string | undefined)[] = [];
    manager.on("connectionChanged", (c) => {
      phases.push(c.progress?.phase ?? `[final:${c.connectionState}]`);
    });

    await manager.connect(csInfo, "claude-opus");

    // Expect at minimum: allocating-port → opening-tunnel → writing-config
    // → verifying-config → starting-health-check → final connected (no progress).
    expect(phases).toContain("allocating-port");
    expect(phases).toContain("opening-tunnel");
    expect(phases).toContain("writing-config");
    expect(phases).toContain("verifying-config");
    expect(phases).toContain("starting-health-check");
    expect(phases[phases.length - 1]).toBe("[final:connected]");

    // Order check: opening-tunnel must come before writing-config; writing
    // before verifying.
    const tunnelIdx = phases.indexOf("opening-tunnel");
    const writeIdx = phases.indexOf("writing-config");
    const verifyIdx = phases.indexOf("verifying-config");
    expect(tunnelIdx).toBeLessThan(writeIdx);
    expect(writeIdx).toBeLessThan(verifyIdx);
  });

  it("emits writing-config attempt counter when first attempt does not verify", async () => {
    const { SshTunnel } = await import("../ssh-tunnel");
    const SshTunnelMock = SshTunnel as unknown as ReturnType<typeof vi.fn>;
    SshTunnelMock.mockImplementation(function () {
      const { EventEmitter } = require("node:events");
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      return tunnel;
    });

    const csInfo = {
      id: 1, name: "test-cs", displayName: "test-cs",
      repository: "user/repo", state: "Available",
      machine: "4-core", lastUsedAt: "2026-04-20T00:00:00Z",
    };
    vi.mocked(executeRemoteCommand)
      .mockResolvedValueOnce("")     // attempt 1: write
      .mockResolvedValueOnce("")     // attempt 1: onboarding
      .mockResolvedValueOnce("0\n")  // attempt 1: verify → not yet
      .mockResolvedValueOnce("")     // attempt 2: write
      .mockResolvedValueOnce("")     // attempt 2: onboarding
      .mockResolvedValueOnce("1\n"); // attempt 2: verify → ok

    const manager = new CodespaceManager(23337, () => "tok");
    const writeAttempts: number[] = [];
    manager.on("connectionChanged", (c) => {
      if (c.progress?.phase === "writing-config" && c.progress.attempt) {
        writeAttempts.push(c.progress.attempt);
      }
    });

    await manager.connect(csInfo, "claude-opus");
    expect(writeAttempts).toEqual([1, 2]);
  }, 30_000);

  it("connect() failure sets errorCode=remote-config-failed", async () => {
    const { SshTunnel } = await import("../ssh-tunnel");
    const SshTunnelMock = SshTunnel as unknown as ReturnType<typeof vi.fn>;
    SshTunnelMock.mockImplementation(function () {
      const { EventEmitter } = require("node:events");
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      return tunnel;
    });

    const csInfo = {
      id: 1, name: "test-cs", displayName: "test-cs",
      repository: "user/repo", state: "Available",
      machine: "4-core", lastUsedAt: "2026-04-20T00:00:00Z",
    };
    vi.mocked(executeRemoteCommand).mockResolvedValue("0\n");

    const manager = new CodespaceManager(23337, () => "tok");
    const errors: any[] = [];
    manager.on("connectionChanged", (c) => {
      if (c.connectionState === "error") errors.push(c);
    });

    await expect(manager.connect(csInfo, "claude-opus")).rejects.toThrow();
    expect(errors[errors.length - 1].errorCode).toBe("remote-config-failed");
  }, 30_000);

  it("sets errorCode=max-reconnect-reached after MAX attempts", async () => {
    const { SshTunnel } = await import("../ssh-tunnel");
    const SshTunnelMock = SshTunnel as unknown as ReturnType<typeof vi.fn>;
    const tunnelInstances: any[] = [];
    SshTunnelMock.mockImplementation(function () {
      const { EventEmitter } = require("node:events");
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      tunnelInstances.push(tunnel);
      return tunnel;
    });

    const csInfo = {
      id: 1, name: "test-cs", displayName: "test-cs",
      repository: "user/repo", state: "Available",
      machine: "4-core", lastUsedAt: "2026-04-20T00:00:00Z",
    };
    // Codespace stays Available so handleUnexpectedDisconnect proceeds with reconnect.
    vi.mocked(listCodespaces).mockResolvedValue([csInfo]);
    vi.mocked(executeRemoteCommand).mockResolvedValue("1\n");

    const manager = new CodespaceManager(23337, () => "tok");
    await manager.connect(csInfo, "claude-opus");

    // Force the connection's reconnectAttempts to MAX so the next exit
    // triggers the max-reconnect-reached path immediately, without
    // burning through the real exponential-backoff timers.
    const conns = manager.getConnections();
    expect(conns).toHaveLength(1);
    // Reach into manager internals to bump the attempt counter.
    (manager as any).connections.get("test-cs").connection.reconnectAttempts = 5;

    const errors: any[] = [];
    manager.on("connectionChanged", (c) => {
      if (c.connectionState === "error") errors.push(c);
    });

    tunnelInstances[0].emit("unexpectedExit", 255);
    // Allow the async handleUnexpectedDisconnect to run through state
    // check + max-attempts branch. No backoff timer is engaged here.
    await new Promise((r) => setTimeout(r, 50));

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[errors.length - 1].errorCode).toBe("max-reconnect-reached");
  });
});
