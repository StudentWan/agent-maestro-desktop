import { describe, it, expect } from "vitest";
import {
  parseWindowTitles,
  extractCodespaceDisplayNameFromTitle,
  listWindowTitles,
  type WindowTitleRunner,
} from "../window-titles";

describe("parseWindowTitles", () => {
  it("parses JSON array output", () => {
    expect(parseWindowTitles(JSON.stringify(["a", "b", "c"]))).toEqual(["a", "b", "c"]);
  });

  it("wraps single string into array (PowerShell collapses 1-element arrays)", () => {
    expect(parseWindowTitles(JSON.stringify("only one"))).toEqual(["only one"]);
  });

  it("returns [] for empty/blank/invalid input", () => {
    expect(parseWindowTitles("")).toEqual([]);
    expect(parseWindowTitles("   ")).toEqual([]);
    expect(parseWindowTitles("not json")).toEqual([]);
  });

  it("filters non-string elements", () => {
    expect(parseWindowTitles(JSON.stringify(["ok", 123, null, "two"]))).toEqual(["ok", "two"]);
  });
});

describe("extractCodespaceDisplayNameFromTitle", () => {
  it("extracts displayName from a typical VS Code Codespaces title", () => {
    const t = "midgard [Codespaces: cautious space orbit] - Visual Studio Code";
    expect(extractCodespaceDisplayNameFromTitle(t)).toBe("cautious space orbit");
  });

  it("handles file prefix", () => {
    const t =
      "BackgroundTaskCardPlugin.test.tsx (Working Tree) ... - midgard [Codespaces: friendly sniffle] - Visual Studio Code";
    expect(extractCodespaceDisplayNameFromTitle(t)).toBe("friendly sniffle");
  });

  it("matches case-insensitively and trims whitespace", () => {
    expect(extractCodespaceDisplayNameFromTitle("[CODESPACES:   spaced out   ]")).toBe("spaced out");
  });

  it("returns null when no marker present", () => {
    expect(extractCodespaceDisplayNameFromTitle("agent-maestro-desktop - Visual Studio Code")).toBeNull();
    expect(extractCodespaceDisplayNameFromTitle("")).toBeNull();
  });

  it("returns null for empty marker content", () => {
    expect(extractCodespaceDisplayNameFromTitle("foo [Codespaces:   ] bar")).toBeNull();
  });
});

describe("listWindowTitles", () => {
  it("returns [] on non-Windows platforms without spawning anything", async () => {
    const runner: WindowTitleRunner = async () => {
      throw new Error("should not be called");
    };
    expect(await listWindowTitles("darwin", runner)).toEqual([]);
    expect(await listWindowTitles("linux", runner)).toEqual([]);
  });

  it("invokes powershell on win32 and parses output", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: WindowTitleRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: JSON.stringify(["a", "b"]), stderr: "" };
    };
    const out = await listWindowTitles("win32", runner);
    expect(out).toEqual(["a", "b"]);
    expect(calls[0].cmd).toBe("powershell.exe");
    expect(calls[0].args).toContain("-NoProfile");
    expect(calls[0].args.join(" ")).toContain("EnumWindows");
  });

  it("returns [] when powershell throws", async () => {
    const runner: WindowTitleRunner = async () => {
      throw new Error("boom");
    };
    expect(await listWindowTitles("win32", runner)).toEqual([]);
  });
});
