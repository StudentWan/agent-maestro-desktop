import { describe, it, expect } from "vitest";
import {
  parseWindowsProcesses,
  parseUnixProcesses,
  listProcesses,
  type ProcessRunner,
} from "../process-list";

describe("parseWindowsProcesses", () => {
  it("parses ConvertTo-Json array output", () => {
    const json = JSON.stringify([
      { ProcessId: 1234, CommandLine: "C:\\foo.exe --flag" },
      { ProcessId: 5678, CommandLine: "ssh user@host" },
    ]);
    const out = parseWindowsProcesses(json);
    expect(out).toEqual([
      { pid: 1234, command: "C:\\foo.exe --flag" },
      { pid: 5678, command: "ssh user@host" },
    ]);
  });

  it("parses single-object output (PowerShell collapses 1-element arrays)", () => {
    const json = JSON.stringify({ ProcessId: 42, CommandLine: "single.exe" });
    const out = parseWindowsProcesses(json);
    expect(out).toEqual([{ pid: 42, command: "single.exe" }]);
  });

  it("skips entries with null/empty command line", () => {
    const json = JSON.stringify([
      { ProcessId: 1, CommandLine: null },
      { ProcessId: 2, CommandLine: "" },
      { ProcessId: 3, CommandLine: "ok.exe" },
    ]);
    expect(parseWindowsProcesses(json)).toEqual([{ pid: 3, command: "ok.exe" }]);
  });

  it("returns [] for empty or invalid JSON", () => {
    expect(parseWindowsProcesses("")).toEqual([]);
    expect(parseWindowsProcesses("   ")).toEqual([]);
    expect(parseWindowsProcesses("not json")).toEqual([]);
  });

  it("coerces string PIDs", () => {
    const json = JSON.stringify([{ ProcessId: "99", CommandLine: "x" }]);
    expect(parseWindowsProcesses(json)).toEqual([{ pid: 99, command: "x" }]);
  });
});

describe("parseUnixProcesses", () => {
  it("parses standard ps output", () => {
    const out = parseUnixProcesses(`  1234 /usr/bin/ssh user@host -N\n  5678 node server.js\n`);
    expect(out).toEqual([
      { pid: 1234, command: "/usr/bin/ssh user@host -N" },
      { pid: 5678, command: "node server.js" },
    ]);
  });

  it("ignores blank lines and malformed lines", () => {
    const out = parseUnixProcesses(`\n  42 cmd\nbad line\n   \n  99 other\n`);
    expect(out).toEqual([
      { pid: 42, command: "cmd" },
      { pid: 99, command: "other" },
    ]);
  });

  it("returns [] on empty input", () => {
    expect(parseUnixProcesses("")).toEqual([]);
  });
});

describe("listProcesses", () => {
  it("uses powershell on win32", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: ProcessRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return {
        stdout: JSON.stringify([{ ProcessId: 1, CommandLine: "x.exe" }]),
        stderr: "",
      };
    };
    const out = await listProcesses("win32", runner);
    expect(out).toEqual([{ pid: 1, command: "x.exe" }]);
    expect(calls[0].cmd).toBe("powershell.exe");
    expect(calls[0].args).toContain("-NoProfile");
    expect(calls[0].args.join(" ")).toContain("Win32_Process");
  });

  it("uses ps on darwin/linux", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: ProcessRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "  77 some/cmd\n", stderr: "" };
    };
    const out = await listProcesses("darwin", runner);
    expect(out).toEqual([{ pid: 77, command: "some/cmd" }]);
    expect(calls[0].cmd).toBe("ps");
    expect(calls[0].args).toEqual(["-A", "-o", "pid=,command="]);
  });
});
