import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import fs from "fs";
import path from "path";

/**
 * afterCopy hook: remove "type": "module" from the packaged package.json
 * so Electron loads the CJS bundle (.vite/build/index.js) correctly.
 *
 * Source package.json keeps "type": "module" for Vitest compatibility.
 */
const removeTypeModule: ForgeConfig["packagerConfig"]["afterCopy"] = [
  (buildPath: string, _electronVersion: string, _platform: string, _arch: string, callback: (err?: Error | null) => void) => {
    try {
      const pkgPath = path.join(buildPath, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      delete pkg.type;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      callback();
    } catch (err) {
      callback(err as Error);
    }
  },
];

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "Agent Maestro Desktop",
    icon: "assets/icons/icon",
    extraResource: ["assets/icons/icon.ico"],
    afterCopy: removeTypeModule,
  },
  makers: [
    new MakerSquirrel({
      // `name` controls the NuGet package id Squirrel uses internally and
      // — critically — the install directory under %LocalAppData%. Keeping
      // it stable across versions avoids old install dirs being left behind.
      // Must be a single token (no spaces).
      name: "AgentMaestroDesktop",
      // `exe` is the produced exe filename Squirrel will reference; it MUST
      // match `packagerConfig.name` (with the `.exe` suffix) so install-time
      // shortcut creation finds the binary.
      exe: "Agent Maestro Desktop.exe",
      setupIcon: "assets/icons/icon.ico",
      // setupExe controls the user-facing installer filename. Without this
      // it defaults to `<name>-<version> Setup.exe` which uses the NuGet
      // id (no spaces); we want the friendly name in the download.
      setupExe: "Agent Maestro Desktop Setup.exe",
    }),
    new MakerZIP({}, ["darwin", "linux"]),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/index.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.main.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
  ],
};

export default config;
