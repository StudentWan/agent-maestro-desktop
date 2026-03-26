import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import path from "path";
import { registerIpcHandlers, cleanup } from "./ipc-handlers";
import { getAutoStart } from "../store/app-store";

// Handle Squirrel events for Windows installer (only when installed via Squirrel)
try {
  if (require("electron-squirrel-startup")) {
    app.quit();
  }
} catch {
  // Not installed via Squirrel, ignore
}

// Log uncaught errors
process.on("uncaughtException", (err) => {
  console.error("[Main] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[Main] Unhandled rejection:", reason);
});

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
      preload: path.join(__dirname, "preload.cjs"),
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
