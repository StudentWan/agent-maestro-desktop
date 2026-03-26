import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    conditions: ["node"],
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
  build: {
    rollupOptions: {
      output: {
        // Use .cjs extension so Node/Electron treats the bundle as CommonJS
        // even when package.json has "type": "module" (needed for Vitest).
        entryFileNames: "[name].cjs",
      },
    },
  },
});
