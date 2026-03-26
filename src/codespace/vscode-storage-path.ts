import path from "node:path";
import os from "node:os";

export interface StoragePathDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Record<string, string | undefined>;
  readonly homedir: () => string;
}

const DEFAULT_DEPS: StoragePathDeps = {
  platform: process.platform,
  env: process.env,
  homedir: os.homedir,
};

const STORAGE_RELATIVE = path.join("Code", "User", "globalStorage", "storage.json");

/**
 * Returns the platform-specific base directory for VS Code storage,
 * or null if the platform is unsupported.
 */
function getBaseDir(deps: StoragePathDeps): string | null {
  const { platform, env, homedir } = deps;

  switch (platform) {
    case "win32": {
      const appData = env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
      return appData;
    }
    case "darwin":
      return path.join(homedir(), "Library", "Application Support");
    case "linux":
      return path.join(homedir(), ".config");
    default:
      return null;
  }
}

/**
 * Returns the absolute path to VS Code's storage.json.
 * Returns null if the platform-specific base directory cannot be determined.
 *
 * Paths:
 *   Windows: %APPDATA%/Code/User/globalStorage/storage.json
 *   macOS:   ~/Library/Application Support/Code/User/globalStorage/storage.json
 *   Linux:   ~/.config/Code/User/globalStorage/storage.json
 */
export function getVscodeStoragePath(deps?: StoragePathDeps): string | null {
  const resolvedDeps = deps ?? DEFAULT_DEPS;
  const baseDir = getBaseDir(resolvedDeps);

  if (baseDir === null) {
    return null;
  }

  return path.join(baseDir, STORAGE_RELATIVE);
}
