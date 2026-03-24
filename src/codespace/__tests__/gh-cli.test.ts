import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkGhCli, parseGhVersion, compareVersions } from "../gh-cli";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
const mockExecFile = vi.mocked(execFile);

describe("parseGhVersion", () => {
  it("parses standard version string", () => {
    expect(parseGhVersion("gh version 2.45.0 (2024-03-01)")).toBe("2.45.0");
  });

  it("parses version without date", () => {
    expect(parseGhVersion("gh version 2.13.0")).toBe("2.13.0");
  });

  it("returns null for invalid input", () => {
    expect(parseGhVersion("not a version")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("2.13.0", "2.13.0")).toBe(0);
  });

  it("returns positive for greater version", () => {
    expect(compareVersions("2.14.0", "2.13.0")).toBeGreaterThan(0);
  });

  it("returns negative for lesser version", () => {
    expect(compareVersions("2.12.0", "2.13.0")).toBeLessThan(0);
  });

  it("handles major version difference", () => {
    expect(compareVersions("3.0.0", "2.99.99")).toBeGreaterThan(0);
  });
});

describe("checkGhCli", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("returns installed=false when gh is not found", async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(new Error("ENOENT"), "", "");
      return {} as any;
    });

    const status = await checkGhCli();
    expect(status.installed).toBe(false);
    expect(status.meetsMinVersion).toBe(false);
  });

  it("returns version info when gh is installed", async () => {
    // First call: gh --version
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(null, "gh version 2.45.0 (2024-03-01)\n", "");
      return {} as any;
    });
    // Second call: gh auth status
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(null, "Logged in to github.com account user (keyring)\nToken scopes: codespace, read:user\n", "");
      return {} as any;
    });

    const status = await checkGhCli();
    expect(status.installed).toBe(true);
    expect(status.version).toBe("2.45.0");
    expect(status.meetsMinVersion).toBe(true);
    expect(status.authenticated).toBe(true);
  });
});
