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
    expect(manager.getConnections()).toEqual([]);
    const lastConn = events[events.length - 1];
    expect(lastConn.connectionState).toBe("available");
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
    expect(manager.getConnections()).toEqual([]);
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
    expect(manager.getConnections()).toEqual([]);
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
});
