import { Tray, Menu, nativeImage } from "electron";

let tray: Tray | null = null;

interface TrayCallbacks {
  onShow: () => void;
  onQuit: () => void;
}

// Minimal valid 16x16 blue PNG icon as base64
// Generated: 16x16 solid blue (#4285F4) circle on transparent background
const TRAY_ICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA" +
  "gklEQVR4nGNgGAWkAkYGBgaG////MzAwMDCwsLAwsLCwMPz/" +
  "/5+BgYGBgZmZmYGFhYWBiYmJ4f///wyMjIwMjIyMDAwMDAz/" +
  "//9nYGRkZPj//z8DIyMjAzMzMwMzMzMDExMTw////xmYmJgY" +
  "mJiYGFhYWBhYWFgYWFlZGVhZWRlGCgAAZfAWEYSMlLIAAAAA" +
  "SUVORK5CYII=";

export function createTray(callbacks: TrayCallbacks): Tray {
  const icon = nativeImage.createFromDataURL(
    `data:image/png;base64,${TRAY_ICON_PNG_BASE64}`,
  );

  tray = new Tray(icon);
  tray.setToolTip("Agent Maestro Desktop");

  updateTrayMenu(callbacks);

  return tray;
}

export function updateTrayMenu(
  callbacks: TrayCallbacks,
  status: { authenticated: boolean; proxyRunning: boolean } = { authenticated: false, proxyRunning: false },
): void {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Auth: ${status.authenticated ? "Connected" : "Not Connected"}`,
      enabled: false,
    },
    {
      label: `Proxy: ${status.proxyRunning ? "Running" : "Stopped"}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Show Window",
      click: callbacks.onShow,
    },
    {
      label: "Quit",
      click: callbacks.onQuit,
    },
  ]);

  tray.setContextMenu(contextMenu);
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
