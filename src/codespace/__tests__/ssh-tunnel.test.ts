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
});
