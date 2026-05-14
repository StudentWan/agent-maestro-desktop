import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

function commonJsMainBundle(): Plugin {
  let outDir = "";
  return {
    name: "agent-maestro-commonjs-main-bundle",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle() {
      if (!outDir) return;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, "package.json"),
        JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
      );
    },
  };
}

export default defineConfig({
  plugins: [commonJsMainBundle()],
  resolve: {
    conditions: ["node"],
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
});
