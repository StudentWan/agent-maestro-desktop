import path from "node:path";

/** Finder launches do not inherit the PATH configured by a terminal shell. */
export function configureMacPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (platform !== "darwin") return;

  const entries = (env.PATH ?? "").split(":").filter(Boolean);
  env.PATH = [...new Set([
    ...entries,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(":");
}

export function getRuntimeIconPath(
  platform: NodeJS.Platform,
  packaged: boolean,
  resourcesPath: string,
  appPath: string,
): string {
  const filename = platform === "win32" ? "icon.ico" : "128x128.png";
  return packaged
    ? path.join(resourcesPath, filename)
    : path.join(appPath, "assets", "icons", filename);
}
