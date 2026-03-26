import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VscodeDetector } from "../vscode-detector";
import type { VscodeDetectorDeps, DetectedCodespace } from "../types";

// ── Helpers ──────────────────────────────────────────────────────

const FIXED_TS = 1700000000000;

function mkCs(name: string): DetectedCodespace {
  return {
    name,
    workspacePath: `/workspaces/${name}`,
    detectedAt: FIXED_TS,
    source: "vscode-storage",
  };
}

function makeStorageJson(codespaceNames: readonly string[]): string {
  if (codespaceNames.length === 0) {
    return JSON.stringify({ windowsState: { openedWindows: [] } });
  }

  const [first, ...rest] = codespaceNames;
  return JSON.stringify({
    windowsState: {
      lastActiveWindow: {
        folder: `vscode-remote://codespaces%2B${first}/workspaces/${first}`,
        remoteAuthority: `codespaces+${first}`,
      },
      openedWindows: rest.map((name) => ({
        folder: `vscode-remote://codespaces%2B${name}/workspaces/${name}`,
        remoteAuthority: `codespaces+${name}`,
      })),
    },
  });
}

function createMockDeps(
  overrides: Partial<VscodeDetectorDeps> = {},
): VscodeDetectorDeps {
  return {
    readFile: vi.fn().mockResolvedValue(makeStorageJson([])),
    watchFile: vi.fn().mockReturnValue({ close: vi.fn() }),
    fileExists: vi.fn().mockResolvedValue(true),
    storagePath: "/mock/storage.json",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("VscodeDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Constructor & Initial State ──────────────────────────────

  describe("Constructor & Initial State", () => {
    it("starts with isWatching false and empty codespaces", () => {
      const deps = createMockDeps();
      const detector = new VscodeDetector(deps);

      expect(detector.isWatching).toBe(false);
      expect(detector.detectedCodespaces).toEqual([]);
    });

    it("start() is a no-op when storagePath is null", async () => {
      const deps = createMockDeps({ storagePath: null });
      const detector = new VscodeDetector(deps);

      await detector.start();

      expect(detector.isWatching).toBe(false);
      expect(deps.readFile).not.toHaveBeenCalled();
    });
  });

  // ── Start & Stop Lifecycle ───────────────────────────────────

  describe("Start & Stop Lifecycle", () => {
    it("start() sets isWatching to true", async () => {
      const deps = createMockDeps();
      const detector = new VscodeDetector(deps, { debounceMs: 0 });

      await detector.start();

      expect(detector.isWatching).toBe(true);
    });

    it("start() performs initial read and detects codespaces", async () => {
      const deps = createMockDeps({
        readFile: vi.fn().mockResolvedValue(
          makeStorageJson(["fluffy-potato-abc"]),
        ),
      });
      const detector = new VscodeDetector(deps, { debounceMs: 0 });

      await detector.start();

      expect(deps.readFile).toHaveBeenCalledWith("/mock/storage.json");
      expect(detector.detectedCodespaces).toHaveLength(1);
      expect(detector.detectedCodespaces[0]!.name).toBe("fluffy-potato-abc");
    });

    it("start() sets up file watcher when file exists", async () => {
      const deps = createMockDeps({
        fileExists: vi.fn().mockResolvedValue(true),
      });
      const detector = new VscodeDetector(deps, { debounceMs: 0 });

      await detector.start();

      expect(deps.watchFile).toHaveBeenCalledWith(
        "/mock/storage.json",
        expect.any(Function),
      );
    });

    it("start() emits watcher-started event", async () => {
      const deps = createMockDeps();
      const detector = new VscodeDetector(deps, { debounceMs: 0 });
      const handler = vi.fn();
      detector.on("watcher-started", handler);

      await detector.start();

      expect(handler).toHaveBeenCalledOnce();
    });

    it("stop() sets isWatching to false", async () => {
      const deps = createMockDeps();
      const detector = new VscodeDetector(deps, { debounceMs: 0 });

      await detector.start();
      detector.stop();

      expect(detector.isWatching).toBe(false);
    });

    it("stop() clears codespaces", async () => {
      const deps = createMockDeps({
        readFile: vi.fn().mockResolvedValue(
          makeStorageJson(["fluffy-potato-abc"]),
        ),
      });
      const detector = new VscodeDetector(deps, { debounceMs: 0 });

      await detector.start();
      expect(detector.detectedCodespaces).toHaveLength(1);

      detector.stop();
      expect(detector.detectedCodespaces).toEqual([]);
    });

    it("stop() closes watcher", async () => {
      const closeFn = vi.fn();
      const deps = createMockDeps({
        watchFile: vi.fn().mockReturnValue({ close: closeFn }),
      });
      const detector = new VscodeDetector(deps, { debounceMs: 0 });

      await detector.start();
      detector.stop();

      expect(closeFn).toHaveBeenCalledOnce();
    });

    it("stop() emits watcher-stopped event", async () => {
      const deps = createMockDeps();
      const detector = new VscodeDetector(deps, { debounceMs: 0 });
      const handler = vi.fn();
      detector.on("watcher-stopped", handler);

      await detector.start();
      detector.stop();

      expect(handler).toHaveBeenCalledOnce();
    });

    it("stop() is a no-op when not watching", () => {
      const deps = createMockDeps();
      const detector = new VscodeDetector(deps);
      const handler = vi.fn();
      detector.on("watcher-stopped", handler);

      detector.stop();

      expect(handler).not.toHaveBeenCalled();
      expect(detector.isWatching).toBe(false);
    });
  });

  // ── File Change Detection ────────────────────────────────────

  describe("File Change Detection", () => {
    it("emits codespace-opened when new codespace appears in storage", async () => {
      const readFileMock = vi
        .fn()
        .mockResolvedValueOnce(makeStorageJson([]))
        .mockResolvedValueOnce(makeStorageJson(["new-codespace"]));

      const deps = createMockDeps({ readFile: readFileMock });
      const detector = new VscodeDetector(deps, { debounceMs: 0 });
      const openedHandler = vi.fn();
      detector.on("codespace-opened", openedHandler);

      await detector.start();

      // Trigger file change callback
      const watchCallback = (deps.watchFile as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as () => void;
      watchCallback();

      // Advance past debounce (0ms) and flush microtasks
      await vi.advanceTimersByTimeAsync(0);

      expect(openedHandler).toHaveBeenCalledOnce();
      expect(openedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ name: "new-codespace" }),
      );
    });

    it("emits codespace-closed when codespace disappears from storage", async () => {
      const readFileMock = vi
        .fn()
        .mockResolvedValueOnce(makeStorageJson(["old-codespace"]))
        .mockResolvedValueOnce(makeStorageJson([]));

      const deps = createMockDeps({ readFile: readFileMock });
      const detector = new VscodeDetector(deps, { debounceMs: 0 });
      const closedHandler = vi.fn();
      detector.on("codespace-closed", closedHandler);

      await detector.start();

      // Trigger file change callback
      const watchCallback = (deps.watchFile as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as () => void;
      watchCallback();

      await vi.advanceTimersByTimeAsync(0);

      expect(closedHandler).toHaveBeenCalledOnce();
      expect(closedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ name: "old-codespace" }),
      );
    });

    it("debounces rapid file changes", async () => {
      const readFileMock = vi
        .fn()
        .mockResolvedValueOnce(makeStorageJson([]))
        .mockResolvedValue(makeStorageJson(["debounced-cs"]));

      const DEBOUNCE_MS = 500;
      const deps = createMockDeps({ readFile: readFileMock });
      const detector = new VscodeDetector(deps, {
        debounceMs: DEBOUNCE_MS,
        pollingFallbackMs: 60_000, // high so polling doesn't interfere
      });

      await detector.start();

      const watchCallback = (deps.watchFile as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as () => void;

      // Fire 5 rapid changes
      watchCallback();
      watchCallback();
      watchCallback();
      watchCallback();
      watchCallback();

      // readFile should have been called once during start (initial read)
      // No additional reads yet (debounce hasn't resolved)
      const callsAfterStart = readFileMock.mock.calls.length;
      expect(callsAfterStart).toBe(1); // only the initial read

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      // Only one additional read should have occurred (debounced)
      expect(readFileMock).toHaveBeenCalledTimes(2);

      detector.stop();
    });
  });

  // ── Polling Fallback ─────────────────────────────────────────

  describe("Polling Fallback", () => {
    it("polls at configured interval", async () => {
      const POLLING_MS = 5_000;
      const readFileMock = vi
        .fn()
        .mockResolvedValue(makeStorageJson([]));

      const deps = createMockDeps({
        readFile: readFileMock,
      });
      const detector = new VscodeDetector(deps, {
        debounceMs: 0,
        pollingFallbackMs: POLLING_MS,
      });

      await detector.start();

      const callsAfterStart = readFileMock.mock.calls.length;

      // Advance one polling interval
      await vi.advanceTimersByTimeAsync(POLLING_MS);
      expect(readFileMock.mock.calls.length).toBe(callsAfterStart + 1);

      // Advance another polling interval
      await vi.advanceTimersByTimeAsync(POLLING_MS);
      expect(readFileMock.mock.calls.length).toBe(callsAfterStart + 2);

      detector.stop();
    });
  });

  // ── Error Handling ───────────────────────────────────────────

  describe("Error Handling", () => {
    it("emits detection-error when readFile fails during polling", async () => {
      const POLLING_MS = 5_000;
      const readFileMock = vi
        .fn()
        .mockResolvedValueOnce(makeStorageJson([])) // initial read OK
        .mockRejectedValue(new Error("EACCES: permission denied"));

      const deps = createMockDeps({
        readFile: readFileMock,
      });
      const detector = new VscodeDetector(deps, {
        debounceMs: 0,
        pollingFallbackMs: POLLING_MS,
      });
      const errorHandler = vi.fn();
      detector.on("detection-error", errorHandler);

      await detector.start();

      // Advance past polling interval to trigger the error
      await vi.advanceTimersByTimeAsync(POLLING_MS);

      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ message: "EACCES: permission denied" }),
      );

      detector.stop();
    });

    it("handles corrupted JSON gracefully (no crash)", async () => {
      const readFileMock = vi
        .fn()
        .mockResolvedValue("{this is not valid json!!!}");

      const deps = createMockDeps({ readFile: readFileMock });
      const detector = new VscodeDetector(deps, { debounceMs: 0 });

      // Should not throw
      await detector.start();

      expect(detector.detectedCodespaces).toEqual([]);

      detector.stop();
    });
  });

  // ── refresh() ────────────────────────────────────────────────

  describe("refresh()", () => {
    it("refresh() forces immediate re-read", async () => {
      const readFileMock = vi
        .fn()
        .mockResolvedValueOnce(makeStorageJson([]))
        .mockResolvedValueOnce(makeStorageJson(["refreshed-cs"]));

      const deps = createMockDeps({ readFile: readFileMock });
      const detector = new VscodeDetector(deps, { debounceMs: 0 });

      await detector.start();
      expect(detector.detectedCodespaces).toEqual([]);

      const result = await detector.refresh();

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("refreshed-cs");
      expect(detector.detectedCodespaces).toHaveLength(1);
    });
  });
});
