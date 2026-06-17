import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import path from "path";
import { spawn } from "node:child_process";
import { registerIpcHandlers, cleanup } from "./ipc-handlers";
import { initializeDiagnostics } from "./diagnostics";
import { getAutoStart } from "../store/app-store";

// Handle Squirrel events for Windows installer (only when installed via Squirrel).
// IMPORTANT: this MUST run before the single-instance lock check below — when
// Squirrel passes us `--squirrel-install`/`--squirrel-updated` it spawns short
// helper processes that should be allowed to do their thing and then quit. If
// the single-instance lock fired first, the install hooks would never run.
//
// We bypass `electron-squirrel-startup` (which does the right thing on
// install/update but doesn't let us specify shortcut locations) and call
// Update.exe directly with `-l Desktop,StartMenu` so both shortcuts are
// guaranteed to land. Without this, some Squirrel default paths land the
// shortcut in a subfolder that Windows search won't surface for "Maestro".
//
// Detach details (Windows-specific):
//   - `stdio: "ignore"` is REQUIRED. Without it Update.exe inherits stdio
//     handles from this process; when this process quits Windows tears down
//     the child process group and Update.exe dies before it finishes
//     writing the .lnk files — exactly the symptom we were seeing where
//     no Desktop / Start-Menu shortcuts appeared after install.
//   - `child.unref()` lets this process exit independently of the child;
//     we still keep `app.quit()` wired to the `close` event for the case
//     where Update.exe finishes quickly.
function handleSquirrelEvent(): boolean {
  if (process.platform !== "win32") return false;
  if (process.argv.length < 2) return false;

  const cmd = process.argv[1];
  const target = path.basename(process.execPath);
  const updateExe = path.resolve(path.dirname(process.execPath), "..", "Update.exe");

  const spawnUpdate = (args: string[]): void => {
    try {
      console.log("[Squirrel] Running:", updateExe, args.join(" "));
      const child = spawn(updateExe, args, {
        detached: true,
        stdio: "ignore",
      });
      child.on("close", (code) => {
        console.log("[Squirrel] Update.exe exited with code", code);
        app.quit();
      });
      child.on("error", (err) => {
        console.error("[Squirrel] Update.exe failed to spawn:", err);
        app.quit();
      });
      child.unref();
    } catch (err) {
      console.error("[Squirrel] Unexpected error spawning Update.exe:", err);
      app.quit();
    }
  };

  switch (cmd) {
    case "--squirrel-install":
    case "--squirrel-updated":
      // -l Desktop,StartMenu = create both shortcuts unambiguously.
      spawnUpdate([`--createShortcut=${target}`, "-l", "Desktop,StartMenu"]);
      return true;
    case "--squirrel-uninstall":
      spawnUpdate([`--removeShortcut=${target}`, "-l", "Desktop,StartMenu"]);
      return true;
    case "--squirrel-obsolete":
      app.quit();
      return true;
    default:
      return false;
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

function getIconPath(): string {
  // In production (packaged), resources are in the app's resources directory
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "icon.ico");
  }
  // In development, use the project root
  return path.join(__dirname, "../../assets/icon.ico");
}

function createTray(): void {
  const iconPath = getIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Agent Maestro Desktop");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function createWindow(): void {
  const iconPath = getIconPath();
  const icon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    show: true,
    title: "Agent Maestro Desktop",
    icon: icon.isEmpty() ? undefined : icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remove menu bar completely
  mainWindow.setMenu(null);

  console.log("[Main] Window created, loading content...");

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    console.log("[Main] Loading dev server URL:", MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    const htmlPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    console.log("[Main] Loading file:", htmlPath);
    mainWindow.loadFile(htmlPath);
  }

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[Main] Content loaded successfully");
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`[Main] Failed to load: ${errorCode} ${errorDescription}`);
  });

  // Close to tray instead of quitting
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// All normal app boot lives inside bootApp(). It is ONLY called when we are
// not handling a Squirrel install/update/uninstall — otherwise the squirrel
// helper instance would also start the proxy server, create a tray icon,
// open the main window, and possibly race with Update.exe writing shortcuts.
function bootApp(): void {
  const diagnosticLogPath = initializeDiagnostics();
  console.log("[Main] Diagnostic logging enabled:", diagnosticLogPath);

  // Single-instance lock. Without this, double-clicking the desktop shortcut
  // twice (or launching from start menu while the tray instance is running)
  // spins up a second Electron process that fights the first for port 23337
  // and creates a second tray icon. Now the second invocation hands off to
  // the already-running instance and exits.
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    // Another instance owns the lock — quit silently. The primary instance's
    // `second-instance` handler (registered below) will surface its window.
    app.quit();
    return;
  }

  // Log uncaught errors
  process.on("uncaughtException", (err) => {
    console.error("[Main] Uncaught exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[Main] Unhandled rejection:", reason);
  });

  app.whenReady().then(() => {
    console.log("[Main] App ready");

    // Register IPC handlers before creating window
    registerIpcHandlers();

    // Create system tray
    createTray();

    // Set auto-launch based on stored preference
    if (!app.isPackaged) {
      // Skip in dev mode
    } else {
      app.setLoginItemSettings({
        openAtLogin: getAutoStart(),
      });
    }

    createWindow();
  });

  // Triggered when a second copy of the app is launched (the second process
  // already quit thanks to the single-instance lock above). Surface the
  // existing window so the user gets the visual feedback they expected from
  // double-clicking the shortcut.
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else {
      // Window was destroyed but app still running — recreate it.
      createWindow();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    cleanup();
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });
}

// Squirrel install/update/uninstall flow takes priority. If this exe was
// launched by Squirrel, handleSquirrelEvent() spawns Update.exe (detached)
// and returns true — we then skip bootApp() entirely so the proxy server,
// tray icon, and main window do not get created during install.
if (!handleSquirrelEvent()) {
  bootApp();
}
