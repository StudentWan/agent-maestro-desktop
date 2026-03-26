import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { spawnSshTunnel } from "./gh-cli";
import { SSH_TUNNEL_CONNECT_TIMEOUT_MS } from "../shared/constants";
import type { CodespaceConnectionState } from "./types";

/**
 * Patterns in SSH verbose (-v) output that indicate the tunnel is established.
 * The "Entering interactive session" or "pledge: " lines appear after auth + channel setup.
 */
const SSH_CONNECTED_PATTERNS = [
  "Entering interactive session",
  "pledge: ",
  "remote forward success",
  "forwarding_success",
] as const;

export class SshTunnel extends EventEmitter {
  private process: ChildProcess | null = null;
  private state: CodespaceConnectionState = "available";
  private intentionalDisconnect = false;

  constructor(
    public readonly codespaceName: string,
    public readonly remotePort: number,
    public readonly localPort: number,
  ) {
    super();
  }

  getState(): CodespaceConnectionState {
    return this.state;
  }

  connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.setState("connecting");

    this.process = spawnSshTunnel(this.codespaceName, this.remotePort, this.localPort);

    this.process.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString();

      // Only log non-debug lines at full level; verbose SSH debug is noisy
      const lines = msg.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        if (line.startsWith("debug1:")) {
          // Suppress verbose debug output unless it contains key info
          if (this.isKeyDebugLine(line)) {
            console.log(`[SSHTunnel:${this.codespaceName}] ${line.trim()}`);
          }
        } else {
          console.log(`[SSHTunnel:${this.codespaceName}] stderr: ${line.trim()}`);
        }
      }

      if (msg.includes("bind: Address already in use")) {
        this.emit("portConflict", this.remotePort);
      }

      // Detect actual connection establishment from SSH verbose output
      if (this.state === "connecting") {
        const connected = SSH_CONNECTED_PATTERNS.some((p) => msg.includes(p));
        if (connected) {
          console.log(`[SSHTunnel:${this.codespaceName}] Tunnel established (detected from SSH output)`);
          this.markConnected();
        }
      }
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      console.log(`[SSHTunnel:${this.codespaceName}] stdout: ${data.toString().trim()}`);
    });

    this.process.on("exit", (code, signal) => {
      console.log(`[SSHTunnel:${this.codespaceName}] exited code=${code} signal=${signal}`);
      this.process = null;

      if (!this.intentionalDisconnect) {
        this.setState("error");
        this.emit("unexpectedExit", code);
      }
    });

    this.process.on("error", (err) => {
      console.error(`[SSHTunnel:${this.codespaceName}] error:`, err.message);
      this.process = null;
      this.setState("error");
    });

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // If process is still running after timeout, consider it connected
        // (fallback if we missed the verbose output pattern)
        if (this.process && !this.process.killed && this.state === "connecting") {
          console.log(`[SSHTunnel:${this.codespaceName}] Timeout reached, assuming connected (process still running)`);
          this.markConnected();
        }
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
    });
  }

  markConnected(): void {
    if (this.state !== "connected") {
      this.setState("connected");
      this.emit("_manualConnect");
    }
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

  private isKeyDebugLine(line: string): boolean {
    return (
      line.includes("remote forward") ||
      line.includes("Entering interactive") ||
      line.includes("pledge:") ||
      line.includes("Authentication succeeded") ||
      line.includes("Connection to") ||
      line.includes("channel") ||
      line.includes("forwarding_success")
    );
  }

  private setState(state: CodespaceConnectionState): void {
    this.state = state;
    this.emit("stateChanged", state);
  }
}
