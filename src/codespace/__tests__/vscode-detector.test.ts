import { describe, it, expect, vi } from "vitest";
import { extractCandidateNames, VsCodeCodespaceDetector } from "../vscode-detector";
import type { CodespaceInfo } from "../types";
import type { ProcessInfo } from "../process-list";

function csInfo(name: string, displayName?: string): CodespaceInfo {
  return {
    id: 1,
    name,
    displayName: displayName ?? name,
    repository: "user/repo",
    state: "Available",
    machine: "4-core",
    lastUsedAt: "2026-04-20T00:00:00Z",
  };
}

describe("extractCandidateNames", () => {
  it("matches gh codespace ssh --codespace name", () => {
    const got = extractCandidateNames("gh codespace ssh --codespace fluffy-octo-doodle-abc123 -- cmd");
    expect(got).toContain("fluffy-octo-doodle-abc123");
  });

  it("matches gh cs ssh -c name", () => {
    const got = extractCandidateNames("gh cs ssh -c fuzzy-tribble-xyz");
    expect(got).toContain("fuzzy-tribble-xyz");
  });

  it("matches user@ssh.codespaces.dev", () => {
    const got = extractCandidateNames(
      "/usr/bin/ssh -L 1234:localhost:5678 fluffy-octo-doodle-abc123@ssh.codespaces.dev",
    );
    expect(got).toContain("fluffy-octo-doodle-abc123");
  });

  it("matches host with subdomain like .ssh.codespaces.dev", () => {
    const got = extractCandidateNames("ssh foo-bar-baz-quux@cs1.ssh.codespaces.dev -N");
    expect(got).toContain("foo-bar-baz-quux");
  });

  it("extracts hex-pattern codespace name from vscode-remote arg", () => {
    const got = extractCandidateNames(
      'Code.exe --remote vscode-remote://codespaces+studentwan-fluffy-octo-doodle-abc123def/workspace',
    );
    expect(got.some((n) => n.includes("fluffy-octo-doodle"))).toBe(true);
  });

  it("returns [] for unrelated commands", () => {
    expect(extractCandidateNames("node server.js")).toEqual([]);
    expect(extractCandidateNames("/usr/bin/zsh")).toEqual([]);
  });

  it("dedupes duplicates", () => {
    const got = extractCandidateNames(
      "gh codespace ssh --codespace foo-bar-baz-q --codespace foo-bar-baz-q",
    );
    expect(got.filter((n) => n === "foo-bar-baz-q")).toHaveLength(1);
  });
});

describe("VsCodeCodespaceDetector", () => {
  it("matches by VS Code window title displayName (primary path)", async () => {
    const titles = [
      "midgard [Codespaces: cautious space orbit] - Visual Studio Code",
      "agent-maestro-desktop - Visual Studio Code",
    ];
    const known = [
      csInfo("studentwan-fluffy-cautious-space-orbit-abc123", "cautious space orbit"),
    ];
    const events: Array<Map<string, CodespaceInfo>> = [];

    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => titles,
      listProcesses: async () => [],
      listCodespaces: async () => known,
    });
    det.on("changed", (m) => events.push(m));

    await det.tick();

    expect(events).toHaveLength(1);
    expect(events[0].size).toBe(1);
    expect(events[0].has("studentwan-fluffy-cautious-space-orbit-abc123")).toBe(true);
  });

  it("detects multiple Codespaces from multiple window titles", async () => {
    const titles = [
      "x [Codespaces: cautious space orbit] - Visual Studio Code",
      "y [Codespaces: friendly sniffle] - Visual Studio Code",
    ];
    const known = [
      csInfo("a-cautious-space-orbit-1", "cautious space orbit"),
      csInfo("b-friendly-sniffle-2", "friendly sniffle"),
    ];
    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => titles,
      listProcesses: async () => [],
      listCodespaces: async () => known,
    });
    const events: Array<Map<string, CodespaceInfo>> = [];
    det.on("changed", (m) => events.push(m));

    await det.tick();
    expect(events[0].size).toBe(2);
    expect([...events[0].keys()].sort()).toEqual([
      "a-cautious-space-orbit-1",
      "b-friendly-sniffle-2",
    ]);
  });

  it("emits 'changed' with intersection of candidates and known codespaces", async () => {
    const procs: ProcessInfo[] = [
      { pid: 1, command: "gh codespace ssh --codespace foo-bar-baz-q" },
      { pid: 2, command: "ssh ghost-ghost-ghost-x@ssh.codespaces.dev" },
    ];
    const known = [csInfo("foo-bar-baz-q")]; // ghost-ghost-ghost-x is NOT in account
    const events: Array<Map<string, CodespaceInfo>> = [];

    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => [],
      listProcesses: async () => procs,
      listCodespaces: async () => known,
    });
    det.on("changed", (m) => events.push(m));

    await det.tick();

    expect(events).toHaveLength(1);
    expect(events[0].size).toBe(1);
    expect(events[0].has("foo-bar-baz-q")).toBe(true);
    expect(events[0].has("ghost-ghost-ghost-x")).toBe(false);
  });

  it("does not emit when set is unchanged", async () => {
    const procs: ProcessInfo[] = [
      { pid: 1, command: "gh codespace ssh --codespace foo-bar-baz-q" },
    ];
    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => [],
      listProcesses: async () => procs,
      listCodespaces: async () => [csInfo("foo-bar-baz-q")],
    });
    const events: Array<Map<string, CodespaceInfo>> = [];
    det.on("changed", (m) => events.push(m));

    await det.tick();
    await det.tick();
    await det.tick();

    expect(events).toHaveLength(1);
  });

  it("emits empty map when all VS Code processes go away", async () => {
    let procs: ProcessInfo[] = [
      { pid: 1, command: "gh codespace ssh --codespace foo-bar-baz-q" },
    ];
    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => [],
      listProcesses: async () => procs,
      listCodespaces: async () => [csInfo("foo-bar-baz-q")],
    });
    const events: Array<Map<string, CodespaceInfo>> = [];
    det.on("changed", (m) => events.push(m));

    await det.tick();
    expect(events).toHaveLength(1);

    procs = [];
    await det.tick();

    expect(events).toHaveLength(2);
    expect(events[1].size).toBe(0);
  });

  it("caches gh cs list within cacheMs window", async () => {
    const procs: ProcessInfo[] = [
      { pid: 1, command: "gh codespace ssh --codespace foo-bar-baz-q" },
    ];
    const listCs = vi.fn().mockResolvedValue([csInfo("foo-bar-baz-q")]);
    let now = 1000;
    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => [],
      listProcesses: async () => procs,
      listCodespaces: listCs,
      codespaceListCacheMs: 5000,
      now: () => now,
    });

    await det.tick();
    now = 2000;
    await det.tick();
    now = 4000;
    await det.tick();
    expect(listCs).toHaveBeenCalledTimes(1);

    now = 7000; // beyond cache
    await det.tick();
    expect(listCs).toHaveBeenCalledTimes(2);
  });

  it("survives listProcesses errors", async () => {
    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => [],
      listProcesses: async () => {
        throw new Error("boom");
      },
      listCodespaces: async () => [],
    });
    await expect(det.tick()).resolves.toBeUndefined();
    expect(det.getCurrent().size).toBe(0);
  });

  it("holds previous state when both enumeration sources fail (no spurious empty emit)", async () => {
    // Regression for the wild-caught log line:
    //   [AutoBridge] grace expired for ... (state=connected) — disconnecting
    // The detector emitting `Map()` because PowerShell hiccuped tricked
    // the auto-bridge into starting a grace timer, which then disconnected
    // a perfectly healthy connection. Now: if we have NO information
    // (both sources failed), we must keep emitting the previous state.
    let titlesFail = false;
    let processesFail = false;
    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => {
        if (titlesFail) throw new Error("user32 not available");
        return [
          "src/main.ts - my-repo [Codespaces: foo-bar-baz-q] - Visual Studio Code",
        ];
      },
      listProcesses: async () => {
        if (processesFail) throw new Error("WMI hiccup");
        return [];
      },
      listCodespaces: async () => [csInfo("foo-bar-baz-q")],
    });

    // First tick: detector sees the codespace.
    await det.tick();
    expect(det.getCurrent().has("foo-bar-baz-q")).toBe(true);

    let changedEmits = 0;
    det.on("changed", () => {
      changedEmits++;
    });

    // Both sources fail: detector must NOT emit an empty map. Previous
    // state stays in `current`, and no `changed` event fires.
    titlesFail = true;
    processesFail = true;
    await det.tick();
    expect(det.getCurrent().has("foo-bar-baz-q")).toBe(true);
    expect(changedEmits).toBe(0);

    // Sources recover, codespace still there: still no change.
    titlesFail = false;
    processesFail = false;
    await det.tick();
    expect(det.getCurrent().has("foo-bar-baz-q")).toBe(true);
    expect(changedEmits).toBe(0);
  });

  it("holds previous state when one source fails and the other returns empty (ambiguous → defer)", async () => {
    let titlesFail = false;
    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => {
        if (titlesFail) throw new Error("user32 not available");
        return [
          "src/main.ts - my-repo [Codespaces: foo-bar-baz-q] - Visual Studio Code",
        ];
      },
      // Process enumeration returns [] (modern VS Code Codespaces extension
      // doesn't expose codespace name in process command lines).
      listProcesses: async () => [],
      listCodespaces: async () => [csInfo("foo-bar-baz-q")],
    });

    await det.tick();
    expect(det.getCurrent().has("foo-bar-baz-q")).toBe(true);

    let changedEmits = 0;
    det.on("changed", () => {
      changedEmits++;
    });

    // Window-title source fails, process source returns []. We have NO
    // reliable signal — must hold previous state, not emit empty.
    titlesFail = true;
    await det.tick();
    expect(det.getCurrent().has("foo-bar-baz-q")).toBe(true);
    expect(changedEmits).toBe(0);
  });

  it("survives listWindowTitles errors and falls back to processes", async () => {
    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => {
        throw new Error("user32 not available");
      },
      listProcesses: async () => [
        { pid: 1, command: "gh codespace ssh --codespace foo-bar-baz-q" },
      ],
      listCodespaces: async () => [csInfo("foo-bar-baz-q")],
    });
    await det.tick();
    expect(det.getCurrent().has("foo-bar-baz-q")).toBe(true);
  });

  it("survives listCodespaces errors and falls back to last cached value", async () => {
    let fail = false;
    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => [],
      listProcesses: async () => [
        { pid: 1, command: "gh codespace ssh --codespace foo-bar-baz-q" },
      ],
      listCodespaces: async () => {
        if (fail) throw new Error("api down");
        return [csInfo("foo-bar-baz-q")];
      },
      codespaceListCacheMs: 0, // force re-fetch every tick
    });
    await det.tick();
    expect(det.getCurrent().has("foo-bar-baz-q")).toBe(true);

    fail = true;
    await det.tick();
    // last cached value still keeps the codespace visible
    expect(det.getCurrent().has("foo-bar-baz-q")).toBe(true);
  });

  it("emits synthetic entry when window title detected but gh cs list returns empty", async () => {
    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => [
        "midgard [Codespaces: cautious space orbit] - Visual Studio Code",
      ],
      listProcesses: async () => [],
      listCodespaces: async () => [],
    });
    const events: Array<Map<string, CodespaceInfo>> = [];
    det.on("changed", (m) => events.push(m));

    await det.tick();
    expect(events).toHaveLength(1);
    expect(events[0].size).toBe(1);
    const entry = events[0].get("cautious space orbit");
    expect(entry).toBeDefined();
    expect(entry?.displayName).toBe("cautious space orbit");
  });

  it("does NOT emit synthetic entries from process-cmd path", async () => {
    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => [],
      listProcesses: async () => [
        { pid: 1, command: "gh codespace ssh --codespace foo-bar-baz-q" },
      ],
      listCodespaces: async () => [],
    });
    const events: Array<Map<string, CodespaceInfo>> = [];
    det.on("changed", (m) => events.push(m));

    await det.tick();
    // No emit because process-cmd matches require whitelist confirmation
    expect(events).toHaveLength(0);
  });

  it("excludes Shutdown codespaces even when window title is still present", async () => {
    // VS Code keeps the [Codespaces: …] title open after the user clicks
    // "Stop codespace". The detector should treat that as "not running" so
    // the auto-bridge can schedule its grace-period disconnect.
    const titles = ["x [Codespaces: cautious space orbit] - Visual Studio Code"];
    const known = [csInfo("studentwan-cautious-space-orbit-1", "cautious space orbit")];
    known[0].state = "Shutdown";

    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => titles,
      listProcesses: async () => [],
      listCodespaces: async () => known,
    });
    const events: Array<Map<string, CodespaceInfo>> = [];
    det.on("changed", (m) => events.push(m));

    await det.tick();
    // Either no emit (initial state was already empty) or empty Map.
    if (events.length > 0) {
      expect(events[0].size).toBe(0);
    }
    expect(det.getCurrent().size).toBe(0);
  });

  it("emits then retracts when codespace transitions Available → Shutdown", async () => {
    const titles = ["x [Codespaces: cautious space orbit] - Visual Studio Code"];
    let state = "Available";
    const cs = csInfo("studentwan-cautious-space-orbit-1", "cautious space orbit");

    const det = new VsCodeCodespaceDetector({
      listWindowTitles: async () => titles,
      listProcesses: async () => [],
      listCodespaces: async () => [{ ...cs, state }],
      codespaceListCacheMs: 0, // force re-fetch each tick
    });
    const events: Array<Map<string, CodespaceInfo>> = [];
    det.on("changed", (m) => events.push(m));

    await det.tick();
    expect(events).toHaveLength(1);
    expect(events[0].size).toBe(1);

    state = "Shutdown";
    await det.tick();

    expect(events).toHaveLength(2);
    expect(events[1].size).toBe(0);
  });
});
