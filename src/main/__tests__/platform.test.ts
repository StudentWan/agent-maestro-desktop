import { describe, expect, it } from "vitest";
import path from "node:path";
import { existsSync } from "node:fs";
import { configureMacPath, getRuntimeIconPath } from "../platform";

describe("configureMacPath", () => {
  it("makes both Homebrew locations available to Finder-launched children", () => {
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", GH_TOKEN: "test-token" };
    configureMacPath("darwin", env);
    expect(env.PATH.split(":")).toEqual([
      "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin",
    ]);
    expect(env.GH_TOKEN).toBe("test-token");
  });

  it("preserves custom command precedence and does not duplicate entries on repeat calls", () => {
    const env = { PATH: "/custom/bin:/opt/homebrew/bin:/usr/bin" };
    configureMacPath("darwin", env);
    const first = env.PATH;
    configureMacPath("darwin", env);
    expect(env.PATH).toBe(first);
    expect(env.PATH.startsWith("/custom/bin:/opt/homebrew/bin:/usr/bin:")).toBe(true);
  });

  it("supplies system tools when PATH is absent", () => {
    const env: NodeJS.ProcessEnv = {};
    configureMacPath("darwin", env);
    expect(env.PATH?.split(":")).toContain("/usr/bin");
    expect(env.PATH?.split(":")).not.toContain("");
  });

  it.each(["win32", "linux"] as const)("leaves %s environment untouched", (platform) => {
    const env = { Path: "C:\\Windows;C:\\Tools", PATH: "custom-value", GH_TOKEN: "token" };
    configureMacPath(platform, env);
    expect(env).toEqual({ Path: "C:\\Windows;C:\\Tools", PATH: "custom-value", GH_TOKEN: "token" });
  });
});

describe("runtime icons", () => {
  it.each([
    ["win32", "icon.ico"],
    ["darwin", "128x128.png"],
  ] as const)("uses an existing development icon and packaged resource on %s", (platform, filename) => {
    const devPath = getRuntimeIconPath(platform, false, "unused", process.cwd());
    expect(devPath).toBe(path.join(process.cwd(), "assets", "icons", filename));
    expect(existsSync(devPath)).toBe(true);
    expect(getRuntimeIconPath(platform, true, "resources", "unused")).toBe(path.join("resources", filename));
  });
});
