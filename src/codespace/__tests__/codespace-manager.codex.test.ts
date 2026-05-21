import { describe, expect, it, vi, beforeEach } from "vitest";
import { CodespaceManager, type AgentModelMap } from "../codespace-manager";
import type { AgentPlugin } from "../../agents/types";

/**
 * Regression test: Codex remote-config failure must NOT tear down the
 * tunnel.
 *
 * The contract is encoded by `AgentRemoteConfig.criticalForTunnel`:
 *   - Claude (criticalForTunnel: true)  → write failure tears down tunnel
 *     so the user isn't lied to about being connected.
 *   - Codex  (criticalForTunnel: false) → write failure logs a warning
 *     but the tunnel stays up; Claude continues to work.
 *
 * If we ever flip the default or accidentally make Codex critical, this
 * test will catch it.
 */

vi.mock("../gh-cli", () => ({
  listCodespaces: vi.fn(),
  executeRemoteCommand: vi.fn(),
  spawnSshTunnel: vi.fn(),
  startCodespace: vi.fn(),
  probeReverseTunnel: vi.fn().mockResolvedValue(true),
}));

vi.mock("../ssh-tunnel", () => {
  const { EventEmitter } = require("node:events");
  return {
    SshTunnel: vi.fn().mockImplementation(function () {
      const tunnel = new EventEmitter();
      tunnel.connect = vi.fn().mockResolvedValue(undefined);
      tunnel.disconnect = vi.fn();
      tunnel.markConnected = vi.fn();
      tunnel.isConnected = vi.fn().mockReturnValue(true);
      tunnel.getState = vi.fn().mockReturnValue("connected");
      tunnel.codespaceName = "test-cs";
      tunnel.remotePort = 23337;
      tunnel.localPort = 23337;
      return tunnel;
    }),
  };
});

import { listCodespaces, executeRemoteCommand } from "../gh-cli";

const CLAUDE_PLUGIN: AgentPlugin = {
  id: "claude",
  displayName: "Claude (test)",
  routePrefix: "",
  modelHint: "",
  registerRoutes: () => {},
  fetchModels: async () => [],
  localConfig: {
    apply: async () => {},
    remove: async () => {},
    writeModel: async () => {},
    getSnippet: () => ({ envVars: {} }),
  },
  remoteConfig: {
    criticalForTunnel: true,
    buildWriteScript: () => "echo claude-write",
    buildPostWriteScript: () => "echo claude-post",
    buildVerifyMarkerCommand: () => "echo claude-verify",
    buildUpdateModelScript: () => "echo claude-update",
    buildRemoveScript: () => "echo claude-remove",
  },
};

const CODEX_PLUGIN: AgentPlugin = {
  id: "codex",
  displayName: "Codex (test)",
  routePrefix: "/codex",
  modelHint: "",
  registerRoutes: () => {},
  fetchModels: async () => [],
  localConfig: {
    apply: async () => {},
    remove: async () => {},
    writeModel: async () => {},
    getSnippet: () => ({ envVars: {} }),
  },
  remoteConfig: {
    criticalForTunnel: false,
    buildWriteScript: () => "echo codex-write",
    buildVerifyMarkerCommand: () => "echo codex-verify",
    buildUpdateModelScript: () => "echo codex-update",
    buildRemoveScript: () => "echo codex-remove",
  },
};

const MODELS: AgentModelMap = { claude: "claude-opus", codex: "gpt-5" } as const;

const CS_INFO = {
  id: 1,
  name: "test-cs",
  displayName: "test-cs",
  repository: "user/repo",
  state: "Available",
  machine: "4-core",
  lastUsedAt: "2026-04-20T00:00:00Z",
};

describe("CodespaceManager + multiple plugins (Codex isolation)", () => {
  beforeEach(() => {
    vi.mocked(listCodespaces).mockReset();
    vi.mocked(executeRemoteCommand).mockReset();
  });

  it("succeeds when Claude verifies but Codex never does (criticalForTunnel:false)", async () => {
    // Pattern: every "echo claude-write" / "echo claude-post" call → "" then
    // every "echo claude-verify" → "1\n", and every "echo codex-write" → ""
    // and every "echo codex-verify" → "0\n" so Codex is retried 4 times and
    // never lands. The tunnel must stay up.
    vi.mocked(executeRemoteCommand).mockImplementation(async (_name, command) => {
      if (command.includes("claude-verify")) return "1\n";
      if (command.includes("codex-verify")) return "0\n";
      return "";
    });

    const manager = new CodespaceManager(
      23337,
      [CLAUDE_PLUGIN, CODEX_PLUGIN],
      () => "tok",
    );
    const result = await manager.connect(CS_INFO, MODELS);
    expect(result.connectionState).toBe("connected");
  }, 30_000);

  it("tears down when Claude verify never lands, even if Codex would have succeeded", async () => {
    vi.mocked(executeRemoteCommand).mockImplementation(async (_name, command) => {
      if (command.includes("claude-verify")) return "0\n"; // critical fails
      if (command.includes("codex-verify")) return "1\n"; // additive succeeds
      return "";
    });

    const manager = new CodespaceManager(
      23337,
      [CLAUDE_PLUGIN, CODEX_PLUGIN],
      () => "tok",
    );
    await expect(manager.connect(CS_INFO, MODELS)).rejects.toThrow(
      /Remote config/i,
    );
    const conns = manager.getConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0].connectionState).toBe("error");
    expect(conns[0].errorCode).toBe("remote-config-failed");
  }, 30_000);

  it("disconnect() runs each plugin's remove script once", async () => {
    // Connect successfully first.
    vi.mocked(listCodespaces).mockResolvedValue([CS_INFO]);
    vi.mocked(executeRemoteCommand).mockImplementation(async (_name, command) => {
      if (command.includes("verify")) return "1\n";
      return "";
    });

    const manager = new CodespaceManager(
      23337,
      [CLAUDE_PLUGIN, CODEX_PLUGIN],
      () => "tok",
    );
    await manager.connect(CS_INFO, MODELS);

    // Disconnect → both plugins' remove scripts must run.
    await manager.disconnect("test-cs");
    const calls = vi.mocked(executeRemoteCommand).mock.calls.map((c) => c[1]);
    expect(calls).toContain("echo claude-remove");
    expect(calls).toContain("echo codex-remove");
  }, 30_000);

  it("updateModel() routes to the right plugin's update script", async () => {
    vi.mocked(listCodespaces).mockResolvedValue([CS_INFO]);
    vi.mocked(executeRemoteCommand).mockImplementation(async (_name, command) => {
      if (command.includes("verify")) return "1\n";
      return "";
    });

    const manager = new CodespaceManager(
      23337,
      [CLAUDE_PLUGIN, CODEX_PLUGIN],
      () => "tok",
    );
    await manager.connect(CS_INFO, MODELS);

    // Reset to isolate the updateModel call.
    vi.mocked(executeRemoteCommand).mockClear();
    vi.mocked(executeRemoteCommand).mockResolvedValue("");
    await manager.updateModel("codex", "gpt-5-mini");

    const calls = vi.mocked(executeRemoteCommand).mock.calls.map((c) => c[1]);
    expect(calls).toContain("echo codex-update");
    expect(calls).not.toContain("echo claude-update");
  }, 30_000);
});
