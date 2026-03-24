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
});
