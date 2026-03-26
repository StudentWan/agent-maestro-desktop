import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkGhCli, parseGhVersion, compareVersions, hasCodespaceScope } from "../gh-cli";

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

  it("returns version info when gh is installed and auth in stdout", async () => {
    // First call: gh --version
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(null, "gh version 2.45.0 (2024-03-01)\n", "");
      return {} as any;
    });
    // Second call: gh auth status — output in stdout (newer gh versions)
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(
        null,
        "github.com\n  ✓ Logged in to github.com account user (keyring)\n  - Token scopes: 'codespace', 'read:user'\n",
        "",
      );
      return {} as any;
    });

    const status = await checkGhCli();
    expect(status.installed).toBe(true);
    expect(status.version).toBe("2.45.0");
    expect(status.meetsMinVersion).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(status.hasCodespaceScope).toBe(true);
  });

  it("detects auth info in stderr (older gh versions)", async () => {
    // First call: gh --version
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(null, "gh version 2.20.0\n", "");
      return {} as any;
    });
    // Second call: gh auth status — output in stderr (older gh versions)
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(
        null,
        "",
        "github.com\n  ✓ Logged in to github.com account user (keyring)\n  - Token scopes: 'codespace', 'repo'\n",
      );
      return {} as any;
    });

    const status = await checkGhCli();
    expect(status.authenticated).toBe(true);
    expect(status.hasCodespaceScope).toBe(true);
  });

  it("detects auth even when gh auth status returns non-zero exit code", async () => {
    // First call: gh --version
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(null, "gh version 2.20.2\n", "");
      return {} as any;
    });
    // Second call: gh auth status — non-zero exit but still has output
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      const error = Object.assign(new Error("exit code 1"), { code: 1 });
      callback(
        error,
        "",
        "github.com\n  ✓ Logged in to github.com account user (keyring)\n  - Token scopes: 'gist', 'read:org', 'repo'\n",
      );
      return {} as any;
    });

    const status = await checkGhCli();
    expect(status.authenticated).toBe(true);
    expect(status.hasCodespaceScope).toBe(false);
  });

  it("returns not authenticated when not logged in", async () => {
    // First call: gh --version
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(null, "gh version 2.45.0\n", "");
      return {} as any;
    });
    // Second call: gh auth status — not logged in
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      const error = Object.assign(new Error("exit code 1"), { code: 1 });
      callback(error, "", "You are not logged in to any GitHub hosts.\n");
      return {} as any;
    });

    const status = await checkGhCli();
    expect(status.authenticated).toBe(false);
    expect(status.hasCodespaceScope).toBe(false);
  });

  it("returns no codespace scope when scope is missing", async () => {
    // First call: gh --version
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(null, "gh version 2.45.0\n", "");
      return {} as any;
    });
    // Second call: gh auth status — logged in but no codespace scope
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(
        null,
        "github.com\n  ✓ Logged in to github.com account user (keyring)\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n",
        "",
      );
      return {} as any;
    });

    const status = await checkGhCli();
    expect(status.authenticated).toBe(true);
    expect(status.hasCodespaceScope).toBe(false);
  });
});

describe("hasCodespaceScope", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("returns true when codespace scope is present", async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(
        null,
        "github.com\n  ✓ Logged in to github.com account user (keyring)\n  - Token scopes: 'codespace', 'read:user'\n",
        "",
      );
      return {} as any;
    });

    const result = await hasCodespaceScope();
    expect(result).toBe(true);
  });

  it("returns false when codespace scope is missing", async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(
        null,
        "github.com\n  ✓ Logged in to github.com account user (keyring)\n  - Token scopes: 'gist', 'read:org', 'repo'\n",
        "",
      );
      return {} as any;
    });

    const result = await hasCodespaceScope();
    expect(result).toBe(false);
  });

  it("returns false when gh is not installed", async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      const error = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      callback(error, "", "");
      return {} as any;
    });

    const result = await hasCodespaceScope();
    expect(result).toBe(false);
  });

  it("returns true when scope appears in stderr (older gh)", async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") callback = _opts;
      callback(
        null,
        "",
        "github.com\n  ✓ Logged in to github.com account user (keyring)\n  - Token scopes: 'codespace', 'repo'\n",
      );
      return {} as any;
    });

    const result = await hasCodespaceScope();
    expect(result).toBe(true);
  });
});
