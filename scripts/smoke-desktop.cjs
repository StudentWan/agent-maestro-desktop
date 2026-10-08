// Run with Electron after `make`; does not start the proxy or change user settings.
const { app, nativeImage, Menu, Tray } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

app.whenReady().then(() => {
  const arch = process.argv[2];
  assert.equal(process.arch, arch, "Smoke test must run on the target architecture");
  const output = path.resolve("out", `Agent Maestro Desktop-${process.platform}-${arch}`);
  const resources = process.platform === "darwin"
    ? path.join(output, "Agent Maestro Desktop.app", "Contents", "Resources")
    : path.join(output, "resources");
  const packaged = JSON.parse(fs.readFileSync(path.join(resources, "app.asar", "package.json"), "utf8"));
  assert.equal(packaged.type, undefined, "Packaged main must load as CommonJS");
  assert.ok(fs.existsSync(path.join(resources, "app.asar", packaged.main)), "Packaged entry point is missing");

  const icon = nativeImage.createFromPath(path.join(resources, process.platform === "win32" ? "icon.ico" : "128x128.png"));
  assert.ok(!icon.isEmpty(), "Packaged runtime icon must decode");
  const tray = new Tray(process.platform === "darwin" ? icon.resize({ width: 18, height: 18 }) : icon);
  tray.setContextMenu(Menu.buildFromTemplate([{ role: "quit" }]));
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    ]));
    assert.ok(Menu.getApplicationMenu());
  }
  tray.destroy();
  console.log(`Desktop smoke passed: ${process.platform} ${arch}`);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
