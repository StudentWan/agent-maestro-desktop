import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { spawnSshTunnel } from "./gh-cli";
import { SSH_TUNNEL_CONNECT_TIMEOUT_MS } from "../shared/constants";
import type { CodespaceConnectionState } from "./types";

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
      console.log(`[SSHTunnel:${this.codespaceName}] stderr: ${msg.trim()}`);

      if (msg.includes("bind: Address already in use")) {
        this.emit("portConflict", this.remotePort);
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
        if (this.process && !this.process.killed) {
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

  private setState(state: CodespaceConnectionState): void {
    this.state = state;
    this.emit("stateChanged", state);
  }
}
