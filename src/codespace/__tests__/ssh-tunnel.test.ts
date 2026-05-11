import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SshTunnel } from "../ssh-tunnel";
import { EventEmitter } from "node:events";

// Mock gh-cli module
vi.mock("../gh-cli", () => ({
  spawnSshTunnel: vi.fn(),
}));

import { spawnSshTunnel } from "../gh-cli";
const mockSpawnSshTunnel = vi.mocked(spawnSshTunnel);

function createMockProcess(): EventEmitter & { kill: ReturnType<typeof vi.fn>; stderr: EventEmitter; stdout: EventEmitter; pid: number } {
  const proc = new EventEmitter() as any;
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

describe("SshTunnel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSpawnSshTunnel.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits connected after successful spawn", async () => {
    const mockProc = createMockProcess();
    mockSpawnSshTunnel.mockReturnValue(mockProc as any);

    const tunnel = new SshTunnel("my-codespace", 23337, 23337);
    const onState = vi.fn();
    tunnel.on("stateChanged", onState);

    const connectPromise = tunnel.connect();

    // Simulate SSH connecting (no early exit = connected)
    await vi.advanceTimersByTimeAsync(3000);
    // Mark as connected after timeout
    tunnel.markConnected();

    await connectPromise;

    expect(onState).toHaveBeenCalledWith("connected");
  });

  it("emits error when process exits unexpectedly", () => {
    const mockProc = createMockProcess();
    mockSpawnSshTunnel.mockReturnValue(mockProc as any);

    const tunnel = new SshTunnel("my-codespace", 23337, 23337);
    const onState = vi.fn();
    tunnel.on("stateChanged", onState);

    tunnel.connect();

    // Simulate process exit
    mockProc.emit("exit", 1, null);

    expect(onState).toHaveBeenCalledWith("error");
  });

  it("detects port conflict from stderr", () => {
    const mockProc = createMockProcess();
    mockSpawnSshTunnel.mockReturnValue(mockProc as any);

    const tunnel = new SshTunnel("my-codespace", 23337, 23337);
    const onPortConflict = vi.fn();
    tunnel.on("portConflict", onPortConflict);

    tunnel.connect();

    mockProc.stderr.emit("data", Buffer.from("bind: Address already in use"));

    expect(onPortConflict).toHaveBeenCalled();
  });

  it("stops and kills process on disconnect", () => {
    const mockProc = createMockProcess();
    mockSpawnSshTunnel.mockReturnValue(mockProc as any);

    const tunnel = new SshTunnel("my-codespace", 23337, 23337);
    tunnel.connect();

    tunnel.disconnect();

    expect(mockProc.kill).toHaveBeenCalled();
  });

  it("promotes to connected as soon as the readiness probe returns true (fast path)", async () => {
    const mockProc = createMockProcess();
    mockSpawnSshTunnel.mockReturnValue(mockProc as any);

    const probe = vi.fn().mockResolvedValue(true);
    const tunnel = new SshTunnel(
      "my-codespace",
      23337,
      23337,
      undefined,
      probe,
    );
    const onState = vi.fn();
    tunnel.on("stateChanged", onState);

    const connectPromise = tunnel.connect();
    // Drain the microtask queue so the probe's resolved promise runs.
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    expect(probe).toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith("connected");
    expect(tunnel.isConnected()).toBe(true);
  });

  it("does NOT mark connected when the probe returns false (no more lying about readiness)", async () => {
    const mockProc = createMockProcess();
    mockSpawnSshTunnel.mockReturnValue(mockProc as any);

    const probe = vi.fn().mockResolvedValue(false);
    const tunnel = new SshTunnel(
      "my-codespace",
      23337,
      23337,
      undefined,
      probe,
    );
    const onState = vi.fn();
    tunnel.on("stateChanged", onState);

    const connectPromise = tunnel.connect();
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // Connect resolved, but tunnel never became connected.
    expect(probe).toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalledWith("connected");
    expect(tunnel.isConnected()).toBe(false);
  });

  it("does NOT mark connected on timeout when a probe is configured (avoid bypassing the gate)", async () => {
    const mockProc = createMockProcess();
    mockSpawnSshTunnel.mockReturnValue(mockProc as any);

    // Probe never resolves within the test window — simulates "tunnel still
    // not bound after 30s".
    const probe = vi.fn().mockImplementation(() => new Promise<boolean>(() => {}));
    const tunnel = new SshTunnel(
      "my-codespace",
      23337,
      23337,
      undefined,
      probe,
    );
    const onState = vi.fn();
    tunnel.on("stateChanged", onState);

    const connectPromise = tunnel.connect();
    // Trip the 30s timeout. Without a probe, this would mark connected.
    // With a probe, it must NOT.
    await vi.advanceTimersByTimeAsync(30_000);
    await connectPromise;

    expect(onState).not.toHaveBeenCalledWith("connected");
    expect(tunnel.isConnected()).toBe(false);
  });
});
