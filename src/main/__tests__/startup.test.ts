import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getAppPath: vi.fn(() => "/project"),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
    setLoginItemSettings: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  getAllWindows: vi.fn(),
  Tray: vi.fn(),
  image: { isEmpty: vi.fn(() => false), resize: vi.fn() },
  Menu: { buildFromTemplate: vi.fn((items) => items), setApplicationMenu: vi.fn() },
  registerIpcHandlers: vi.fn(),
  cleanup: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: Object.assign(mocks.BrowserWindow, { getAllWindows: mocks.getAllWindows }),
  Tray: mocks.Tray,
  nativeImage: { createFromPath: () => mocks.image, createEmpty: () => mocks.image },
  Menu: mocks.Menu,
}));
vi.mock("../ipc-handlers", () => ({ registerIpcHandlers: mocks.registerIpcHandlers, cleanup: mocks.cleanup }));
vi.mock("../diagnostics", () => ({ initializeDiagnostics: () => "/test/diagnostic.log" }));
vi.mock("../../store/app-store", () => ({ getAutoStart: () => true }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

const descriptors = Object.getOwnPropertyDescriptors(process);
const processEvents: EventEmitter = process;
let window: EventEmitter & Record<string, any>;
let tray: EventEmitter & Record<string, any>;
let listeners: Map<string, Function[]>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  listeners = new Map(["uncaughtException", "unhandledRejection"].map((event) => [event, processEvents.listeners(event)]));
  vi.stubEnv("PATH", "/usr/bin:/bin");
  vi.stubGlobal("MAIN_WINDOW_VITE_DEV_SERVER_URL", "http://localhost:5173");
  window = Object.assign(new EventEmitter(), {
    setMenu: vi.fn(), loadURL: vi.fn(), loadFile: vi.fn(),
    hide: vi.fn(), show: vi.fn(), focus: vi.fn(), restore: vi.fn(),
    isMinimized: vi.fn(() => true), isVisible: vi.fn(() => false),
    webContents: new EventEmitter(),
  });
  tray = Object.assign(new EventEmitter(), {
    setToolTip: vi.fn(), setContextMenu: vi.fn(), destroy: vi.fn(),
  });
  mocks.BrowserWindow.mockImplementation(function () { return window; });
  mocks.Tray.mockImplementation(function () { return tray; });
  mocks.getAllWindows.mockReturnValue([window]);
  mocks.image.resize.mockReturnValue(mocks.image);
});

afterEach(() => {
  for (const [event, previous] of listeners) {
    for (const listener of processEvents.listeners(event)) {
      if (!previous.includes(listener)) processEvents.removeListener(event, listener as (...args: unknown[]) => void);
    }
  }
  for (const key of ["platform", "argv", "resourcesPath"]) {
    if (descriptors[key]) Object.defineProperty(process, key, descriptors[key]);
    else Reflect.deleteProperty(process, key);
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function start(platform: NodeJS.Platform, event?: string): Promise<void> {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: "/resources" });
  Object.defineProperty(process, "argv", { configurable: true, value: event ? [process.execPath, event] : [process.execPath] });
  await import("../index");
}

function emitApp(event: string): void {
  const handler = mocks.app.on.mock.calls.find(([name]) => name === event)?.[1];
  expect(handler).toBeTypeOf("function");
  handler();
}

describe("desktop startup", () => {
  it.each(["win32", "darwin"] as const)("preserves close-to-tray, login preference, single-instance restore and cleanup on %s", async (platform) => {
    await start(platform);
    expect(mocks.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(mocks.registerIpcHandlers).toHaveBeenCalledOnce();
    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    const event = { preventDefault: vi.fn() };
    window.emit("close", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    emitApp("second-instance");
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    emitApp("before-quit");
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(tray.destroy).toHaveBeenCalledOnce();
    const quitting = { preventDefault: vi.fn() };
    window.emit("close", quitting);
    expect(quitting.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps Windows menus, tray size and PATH unchanged", async () => {
    await start("win32");
    expect(window.setMenu).toHaveBeenCalledWith(null);
    expect(mocks.Menu.setApplicationMenu).not.toHaveBeenCalled();
    expect(mocks.image.resize).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("sets macOS menus and CLI paths before starting services, and restores a minimized Dock window", async () => {
    mocks.registerIpcHandlers.mockImplementationOnce(() => {
      expect(process.env.PATH?.split(":")).toContain("/opt/homebrew/bin");
    });
    await start("darwin");
    expect(mocks.Menu.setApplicationMenu).toHaveBeenCalledWith([
      { role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    ]);
    expect(window.setMenu).not.toHaveBeenCalled();
    expect(mocks.image.resize).toHaveBeenCalledWith({ width: 18, height: 18 });
    emitApp("activate");
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    emitApp("window-all-closed");
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it.each(["--squirrel-install", "--squirrel-updated", "--squirrel-uninstall"])("handles Windows %s before starting the app", async (event) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReturnValue(child);
    await start("win32", event);
    expect(mocks.app.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(mocks.registerIpcHandlers).not.toHaveBeenCalled();
    const args = mocks.spawn.mock.calls[0][1];
    expect(args[0]).toMatch(event === "--squirrel-uninstall" ? /^--removeShortcut=/ : /^--createShortcut=/);
    expect(args.slice(1)).toEqual(["-l", "Desktop,StartMenu"]);
    expect(mocks.spawn.mock.calls[0][2]).toEqual({ detached: true, stdio: "ignore" });
    expect(child.unref).toHaveBeenCalledOnce();
    child.emit("close", 0);
    expect(mocks.app.quit).toHaveBeenCalledOnce();
  });
});
