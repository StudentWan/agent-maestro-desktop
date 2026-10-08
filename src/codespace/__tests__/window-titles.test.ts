import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
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
  it("returns [] on Linux without spawning anything", async () => {
    const runner = vi.fn<WindowTitleRunner>();
    expect(await listWindowTitles("linux", runner)).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("reads macOS VS Code titles as JSON without splitting punctuation or Unicode", async () => {
    const titles = ['项目, "notes" [Codespaces: quiet river] — Visual Studio Code', "second\nwindow"];
    const runner = vi.fn<WindowTitleRunner>().mockResolvedValue({ stdout: JSON.stringify(titles), stderr: "" });
    expect(await listWindowTitles("darwin", runner)).toEqual(titles);
    const [cmd, args, options] = runner.mock.calls[0];
    expect(cmd).toBe("/usr/bin/osascript");
    expect(args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(args[3]).toContain("com.microsoft.VSCodeInsiders");
    expect(options?.timeout).toBe(5000);
  });

  it("returns an empty macOS snapshot when no editor windows are open", async () => {
    expect(await listWindowTitles("darwin", async () => ({ stdout: "[]\n", stderr: "" }))).toEqual([]);
  });

  it("reports macOS permission failures so the detector retains its previous observation", async () => {
    const denied = new Error("osascript is not allowed assistive access (-1719)");
    await expect(listWindowTitles("darwin", async () => { throw denied; })).rejects.toThrow(denied);
  });

  it.each(["", "not json", '"one title"', '[123]'])("rejects invalid macOS output %j", async (stdout) => {
    await expect(listWindowTitles("darwin", async () => ({ stdout, stderr: "" }))).rejects.toThrow();
  });

  it.skipIf(process.platform !== "darwin")("compiles the actual detection script with macOS JavaScript for Automation", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "maestro-jxa-"));
    try {
      await listWindowTitles("darwin", async (_cmd, args) => {
        execFileSync("/usr/bin/osacompile", ["-l", "JavaScript", "-o", path.join(tempDir, "detect.scpt"), "-e", args[3]]);
        return { stdout: "[]", stderr: "" };
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
