import { describe, it, expect } from "vitest";
import path from "node:path";
import { getVscodeStoragePath, type StoragePathDeps } from "../vscode-storage-path";

const STORAGE_SUFFIX = path.join("Code", "User", "globalStorage", "storage.json");

function createDeps(overrides: Partial<StoragePathDeps> = {}): StoragePathDeps {
  return {
    platform: overrides.platform ?? "linux",
    env: overrides.env ?? {},
    homedir: overrides.homedir ?? (() => "/home/testuser"),
  };
}

describe("getVscodeStoragePath", () => {
  describe("Windows", () => {
    it("returns path using APPDATA when env var is set", () => {
      const deps = createDeps({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\testuser\\AppData\\Roaming" },
        homedir: () => "C:\\Users\\testuser",
      });

      const result = getVscodeStoragePath(deps);

      expect(result).toBe(
        path.join("C:\\Users\\testuser\\AppData\\Roaming", STORAGE_SUFFIX),
      );
    });

    it("falls back to homedir/AppData/Roaming when APPDATA is undefined", () => {
      const deps = createDeps({
        platform: "win32",
        env: {},
        homedir: () => "C:\\Users\\testuser",
      });

      const result = getVscodeStoragePath(deps);

      expect(result).toBe(
        path.join("C:\\Users\\testuser", "AppData", "Roaming", STORAGE_SUFFIX),
      );
    });
  });

  describe("macOS", () => {
    it("returns path via homedir/Library/Application Support", () => {
      const deps = createDeps({
        platform: "darwin",
        homedir: () => "/Users/testuser",
      });

      const result = getVscodeStoragePath(deps);

      expect(result).toBe(
        path.join("/Users/testuser", "Library", "Application Support", STORAGE_SUFFIX),
      );
    });
  });

  describe("Linux", () => {
    it("returns path via homedir/.config", () => {
      const deps = createDeps({
        platform: "linux",
        homedir: () => "/home/testuser",
      });

      const result = getVscodeStoragePath(deps);

      expect(result).toBe(
        path.join("/home/testuser", ".config", STORAGE_SUFFIX),
      );
    });
  });

  describe("unknown platform", () => {
    it("returns null for unsupported platforms", () => {
      const deps = createDeps({
        platform: "freebsd" as NodeJS.Platform,
        homedir: () => "/home/testuser",
      });

      const result = getVscodeStoragePath(deps);

      expect(result).toBeNull();
    });
  });
});
