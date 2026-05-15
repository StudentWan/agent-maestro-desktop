import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { spawnSshTunnel } from "./gh-cli";
import { SSH_TUNNEL_CONNECT_TIMEOUT_MS } from "../shared/constants";
import type { CodespaceConnectionState } from "./types";

export class SshTunnel extends EventEmitter {
  private process: ChildProcess | null = null;
  private state: CodespaceConnectionState = "available";
  private intentionalDisconnect = false;
  private readonly getToken: (() => string | undefined) | undefined;
  /**
   * Optional end-to-end readiness probe. When provided, `connect()` will not
   * mark the tunnel as connected on the 30s timeout — it will wait for the
   * probe to return true (fast path: ~1s) or for the timeout to fire (the
   * tunnel is then left in "connecting" so the caller can detect failure
   * via `isConnected()`).
   *
   * The probe should verify the reverse port forward is actually listening
   * inside the codespace. Returning false means "give up", returning true
   * promotes the tunnel to "connected" immediately.
   */
  private readonly probeReady: (() => Promise<boolean>) | undefined;

  constructor(
    public readonly codespaceName: string,
    public readonly remotePort: number,
    public readonly localPort: number,
    getToken?: () => string | undefined,
    probeReady?: () => Promise<boolean>,
  ) {
    super();
    this.getToken = getToken;
    this.probeReady = probeReady;
  }

  getState(): CodespaceConnectionState {
    return this.state;
  }

  connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.setState("connecting");

    this.process = spawnSshTunnel(
      this.codespaceName,
      this.remotePort,
      this.localPort,
      this.getToken?.(),
    );

    this.process.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString();
      console.log(`[${new Date().toISOString()}] [SSHTunnel:${this.codespaceName}] stderr: ${msg.trim()}`);

      // Detect reverse port forward failures. SSH can report these in
      // different ways depending on the version and the cause:
      //   - "bind: Address already in use" — port occupied by another process
      //   - "Warning: remote port forwarding failed for listen port ..." —
      //     catch-all (permissions, port in TIME_WAIT, etc.)
      // Both mean we should retry with a different remote port.
      if (
        msg.includes("bind: Address already in use") ||
        msg.includes("remote port forwarding failed")
      ) {
        this.emit("portConflict", this.remotePort);
      }
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      console.log(`[${new Date().toISOString()}] [SSHTunnel:${this.codespaceName}] stdout: ${data.toString().trim()}`);
    });

    this.process.on("exit", (code, signal) => {
      console.log(
        `[${new Date().toISOString()}] [SSHTunnel:${this.codespaceName}] process exited code=${code} signal=${signal} intentional=${this.intentionalDisconnect}`,
      );
      this.process = null;

      if (!this.intentionalDisconnect) {
        this.setState("error");
        this.emit("unexpectedExit", code);
      }
    });

    this.process.on("error", (err) => {
      console.error(`[${new Date().toISOString()}] [SSHTunnel:${this.codespaceName}] process error:`, err.message);
      this.process = null;
      this.setState("error");
    });

    return new Promise<void>((resolve) => {
      // The 30s timeout is now a HARD UPPER BOUND, not a "we're ready" signal.
      // Whether we mark the tunnel as connected on timeout depends on whether
      // a readiness probe was supplied and what it returned.
      const timeout = setTimeout(() => {
        if (!this.process || this.process.killed) {
          // Process died during the wait — exit handler already set "error".
          resolve();
          return;
        }
        if (!this.probeReady) {
          // No probe configured: preserve legacy behavior so callers that
          // don't opt in (e.g. tests) still see "connected" after the
          // timeout window. The caller's own verification step (e.g.
          // writeRemoteConfigWithRetry) is the real gate in that case.
          this.markConnected();
        }
        // With a probe configured but no successful result by 30s, leave the
        // state as "connecting" — the probe loop will either flip us to
        // connected when it succeeds, or the caller will tear us down.
        resolve();
      }, SSH_TUNNEL_CONNECT_TIMEOUT_MS);

      // If process exits before timeout, resolve early (state is set to error by exit handler)
      const earlyExitHandler = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.process?.once("exit", earlyExitHandler);

      // Allow manual marking as connected (clears timeout)
      this.once("_manualConnect", () => {
        clearTimeout(timeout);
        this.process?.removeListener("exit", earlyExitHandler);
        resolve();
      });

      // Run the readiness probe in parallel with the timeout. As soon as it
      // returns true we promote to connected and resolve immediately — no
      // need to burn the full 30s when the tunnel bound in 800ms. As soon
      // as it gives up we resolve with the tunnel still in "connecting", so
      // the caller's `isConnected()` check fails fast and the connect path
      // can mark this as ssh-tunnel-failed instead of misleading the user.
      if (this.probeReady) {
        const probe = this.probeReady;
        void (async () => {
          try {
            const ok = await probe();
            if (!ok) {
              // Probe gave up before the timeout. Resolve so the caller can
              // distinguish "tunnel not ready" from "still trying" via
              // isConnected().
              console.warn(
                `[${new Date().toISOString()}] [SSHTunnel:${this.codespaceName}] ` +
                  `readiness probe returned false — reverse port forward on :${this.remotePort} ` +
                  `never accepted connections`,
              );
              clearTimeout(timeout);
              this.process?.removeListener("exit", earlyExitHandler);
              resolve();
              return;
            }
            if (this.process && !this.process.killed && this.state !== "connected") {
              this.markConnected();
            }
          } catch (probeErr) {
            // Probe threw — treat as "not ready", same as ok===false.
            console.warn(
              `[${new Date().toISOString()}] [SSHTunnel:${this.codespaceName}] ` +
                `readiness probe threw:`,
              probeErr instanceof Error ? probeErr.message : probeErr,
            );
            clearTimeout(timeout);
            this.process?.removeListener("exit", earlyExitHandler);
            resolve();
          }
        })();
      }
    });
  }

  markConnected(): void {
    this.setState("connected");
    this.emit("_manualConnect");
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.setState("available");
  }

  isConnected(): boolean {
    return this.state === "connected" && this.process !== null;
  }

  /** PID of the SSH child process, or null when not running. */
  getPid(): number | null {
    return this.process?.pid ?? null;
  }

  private setState(state: CodespaceConnectionState): void {
    this.state = state;
    this.emit("stateChanged", state);
  }
}
