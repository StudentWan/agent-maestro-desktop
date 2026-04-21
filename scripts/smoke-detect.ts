// Real-world smoke test: enumerate Windows + run gh cs list, see if the detector matches.
// Run: npx tsx scripts/smoke-detect.ts
import { listWindowTitles, extractCodespaceDisplayNameFromTitle } from "../src/codespace/window-titles";
import { listCodespaces } from "../src/codespace/gh-cli";
import { VsCodeCodespaceDetector } from "../src/codespace/vscode-detector";

async function main() {
  console.log("=== Window titles ===");
  const titles = await listWindowTitles();
  for (const t of titles) {
    const name = extractCodespaceDisplayNameFromTitle(t);
    if (name) {
      console.log(`  ✓ "${t}"  →  displayName="${name}"`);
    }
  }
  console.log(`(${titles.length} total titles, ${titles.filter((t) => extractCodespaceDisplayNameFromTitle(t)).length} matched)`);

  console.log("\n=== gh cs list ===");
  let codespaces: Awaited<ReturnType<typeof listCodespaces>> = [];
  try {
    codespaces = await listCodespaces();
    for (const cs of codespaces) {
      console.log(`  ${cs.name}  (displayName="${cs.displayName}", state=${cs.state})`);
    }
  } catch (err) {
    console.error("gh cs list failed:", err);
  }

  console.log("\n=== Detector tick ===");
  const det = new VsCodeCodespaceDetector({
    listCodespaces: async () => codespaces,
  });
  det.on("changed", (m) => {
    console.log(`  emitted "changed" with ${m.size} codespace(s):`);
    for (const [name, info] of m) {
      console.log(`    - ${name}  (display="${info.displayName}")`);
    }
  });
  await det.tick();
  const current = det.getCurrent();
  if (current.size === 0) {
    console.log("  (no codespaces detected)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
