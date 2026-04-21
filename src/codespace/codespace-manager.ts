import { EventEmitter } from "node:events";
import { SshTunnel } from "./ssh-tunnel";
import { listCodespaces as ghListCodespaces, executeRemoteCommand, startCodespace as ghStartCodespace } from "./gh-cli";
import {
  buildWriteConfigScript,
  buildWriteOnboardingScript,
  buildRemoveConfigScript,
  buildUpdateModelScript,
} from "./remote-config";
import { MAX_RECONNECT_ATTEMPTS, MAX_PORT_RETRIES, CODESPACE_HEALTH_CHECK_INTERVAL_MS } from "../shared/constants";
import type { CodespaceInfo, CodespaceConnection, CodespaceConnectionSource } from "./types";

interface ConnectionEntry {
  readonly connection: CodespaceConnection;
  tunnel: SshTunnel;
  healthTimer: ReturnType<typeof setInterval> | null;
}

function updateConnection(
  conn: CodespaceConnection,
  patch: Partial<CodespaceConnection>,
): CodespaceConnection {
  return { ...conn, ...patch };
}

export class CodespaceManager extends EventEmitter {
  private connections = new Map<string, ConnectionEntry>();
  private allocatedPorts = new Set<number>();
  private basePort: number;
  private getToken: () => string | undefined;

  constructor(basePort: number, getToken: () => string | undefined = () => undefined) {
    super();
    this.basePort = basePort;
    this.getToken = getToken;
  }

  /** Update the token provider (e.g., after re-authorization). */
  setTokenProvider(getToken: () => string | undefined): void {
    this.getToken = getToken;
  }

  private exec(name: string, command: string, timeoutMs?: number): Promise<string> {
    return executeRemoteCommand(name, command, timeoutMs, this.getToken());
  }

  /**
   * Write the remote `~/.claude/settings.json` + onboarding marker, then
   * verify the file landed by reading it back. Retries with exponential
   * backoff because freshly-resumed codespaces often refuse SSH for the
   * first few seconds.
   *
   * Returns true on success, false after exhausting retries.
   */
  private async writeRemoteConfigWithRetry(
    name: string,
    remotePort: number,
    model: string,
  ): Promise<boolean> {
    const attempts = [0, 2_000, 5_000, 10_000]; // 4 attempts: now, +2s, +5s, +10s
    for (let i = 0; i < attempts.length; i++) {
      if (attempts[i] > 0) {
        await new Promise((r) => setTimeout(r, attempts[i]));
      }
      try {
        await this.exec(name, buildWriteConfigScript(remotePort, model));
        await this.exec(name, buildWriteOnboardingScript());

        // Verify the marker actually landed. Cheap: cat the file and grep
        // for the AGENT_MAESTRO_MANAGED key.
        const verify = await this.exec(
          name,
          "cat ~/.claude/settings.json 2>/dev/null | grep -c AGENT_MAESTRO_MANAGED || true",
        );
        if (parseInt(verify.trim(), 10) > 0) {
          if (i > 0) {
            console.log(`[CodespaceManager] Remote config landed for ${name} on attempt ${i + 1}`);
          }
          return true;
        }
        console.warn(`[CodespaceManager] Remote config verify failed for ${name} (attempt ${i + 1})`);
      } catch (err) {
        console.warn(`[CodespaceManager] Remote config attempt ${i + 1} failed for ${name}:`, err);
      }
    }
    return false;
  }

  allocatePort(): number {
    let port = this.basePort;
    while (this.allocatedPorts.has(port)) {
      port++;
    }
    this.allocatedPorts.add(port);
    return port;
  }

  freePort(port: number): void {
    this.allocatedPorts.delete(port);
  }

  async list(): Promise<CodespaceInfo[]> {
    return ghListCodespaces(this.getToken());
  }

  getConnections(): CodespaceConnection[] {
    return Array.from(this.connections.values()).map((e) => ({ ...e.connection }));
  }

  getConnection(name: string): CodespaceConnection | undefined {
    const entry = this.connections.get(name);
    return entry ? { ...entry.connection } : undefined;
  }

  /** Start a shutdown Codespace, then connect to it. */
  async startAndConnect(
    info: CodespaceInfo,
    model: string,
    source: CodespaceConnectionSource = "manual",
  ): Promise<CodespaceConnection> {
    await ghStartCodespace(info.name, this.getToken());
    // Wait a moment for the Codespace to become Available
    await new Promise((r) => setTimeout(r, 5000));
    const updatedInfo: CodespaceInfo = { ...info, state: "Available" };
    return this.connect(updatedInfo, model, source);
  }

  async connect(
    info: CodespaceInfo,
    model: string,
    source: CodespaceConnectionSource = "manual",
  ): Promise<CodespaceConnection> {
    if (this.connections.has(info.name)) {
      throw new Error(`Already connected to ${info.name}`);
    }

    const localPort = this.basePort;
    let remotePort = this.allocatePort();

    let connection: CodespaceConnection = {
      id: info.name,
      info,
      connectionState: "connecting",
      remotePort,
      localPort,
      connectedAt: null,
      lastHealthCheck: null,
      reconnectAttempts: 0,
      source,
    };

    this.emitConnection(connection);

    // Port conflict retry loop
    let tunnel: SshTunnel | null = null;
    let portRetries = 0;

    while (portRetries < MAX_PORT_RETRIES) {
      tunnel = new SshTunnel(info.name, remotePort, localPort, this.getToken);

      let portConflict = false;
      tunnel.on("portConflict", () => {
        portConflict = true;
      });

      try {
        await tunnel.connect();
        if (!portConflict) break;
      } catch {
        if (!portConflict) throw new Error("SSH tunnel failed to establish");
      }

      // Port conflict — try next port
      tunnel.disconnect();
      this.freePort(remotePort);
      remotePort = this.allocatePort();
      connection = updateConnection(connection, { remotePort });
      portRetries++;
    }

    if (!tunnel || !tunnel.isConnected()) {
      this.freePort(remotePort);
      connection = updateConnection(connection, {
        connectionState: "error",
        errorMessage: "Failed to find available port",
      });
      this.emitConnection(connection);
      throw new Error("Failed to find available port after retries");
    }

    // Configure remote Claude Code.
    //
    // The remote-config write is critical: if it doesn't land, the user's
    // `claude` in the codespace will use whatever default ANTHROPIC_BASE_URL
    // it had (i.e., NOT routed through our proxy). Symptom: "tunnel says
    // connected but messages don't reach the app".
    //
    // Why retry: `gh codespace ssh` opens a new SSH session per invocation,
    // and a freshly-resumed codespace can take 5-30s before sshd accepts
    // commands cleanly. Without retries, the first attempt often fails
    // silently and we mark the connection "connected" with a stale config.
    const configWritten = await this.writeRemoteConfigWithRetry(
      info.name,
      remotePort,
      model,
    );

    if (!configWritten) {
      // Tear down the half-working connection — leaving it up tricks the
      // user into thinking the proxy is active when it's not.
      console.warn(`[CodespaceManager] Remote config write failed for ${info.name} after retries; tearing down`);
      tunnel.disconnect();
      this.freePort(remotePort);
      connection = updateConnection(connection, {
        connectionState: "error",
        errorMessage: "Failed to configure Claude Code in codespace (SSH not ready or python3 missing)",
      });
      this.emitConnection(connection);
      throw new Error("Remote config write failed");
    }

    // Setup reconnect handler
    tunnel.on("unexpectedExit", () => {
      this.handleUnexpectedDisconnect(info.name, model);
    });

    // Start health check (app-level: curl /health through tunnel)
    const healthTimer = setInterval(() => {
      this.healthCheck(info.name);
    }, CODESPACE_HEALTH_CHECK_INTERVAL_MS);

    connection = updateConnection(connection, {
      connectionState: "connected",
      connectedAt: Date.now(),
    });

    this.connections.set(info.name, { connection, tunnel, healthTimer });
    this.emitConnection(connection);

    return { ...connection };
  }

  async disconnect(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) return;

    let connection = updateConnection(entry.connection, { connectionState: "disconnecting" });
    this.connections.set(name, { ...entry, connection });
    this.emitConnection(connection);

    // Stop health check
    if (entry.healthTimer) clearInterval(entry.healthTimer);

    // Clean remote config (best-effort) — but ONLY if the codespace is
    // still Available. `gh codespace ssh` auto-starts stopped codespaces,
    // so running cleanup against a stopped one would resurrect it.
    let stillAvailable = false;
    try {
      const list = await ghListCodespaces(this.getToken());
      stillAvailable = list.find((cs) => cs.name === name)?.state === "Available";
    } catch {
      // If we can't tell, skip the cleanup — better to leave a stale
      // config file on the remote than to wake the codespace.
      stillAvailable = false;
    }

    if (stillAvailable) {
      try {
        await this.exec(name, buildRemoveConfigScript());
      } catch {
        console.warn(`[CodespaceManager] Remote config cleanup failed for ${name}`);
      }
    } else {
      console.log(`[CodespaceManager] Skipping remote cleanup for ${name} — not Available`);
    }

    // Kill tunnel
    entry.tunnel.disconnect();
    this.freePort(connection.remotePort);

    connection = updateConnection(connection, { connectionState: "available" });
    this.connections.delete(name);
    this.emitConnection(connection);
  }

  async disconnectAll(): Promise<void> {
    const names = Array.from(this.connections.keys());
    await Promise.allSettled(names.map((name) => this.disconnect(name)));
  }

  /** Synchronous kill of all SSH processes. Used during app quit. */
  killAllTunnels(): void {
    for (const [, entry] of this.connections) {
      if (entry.healthTimer) clearInterval(entry.healthTimer);
      entry.tunnel.disconnect();
    }
    this.connections.clear();
    this.allocatedPorts.clear();
  }

  async updateModel(model: string): Promise<void> {
    const promises = Array.from(this.connections.entries()).map(async ([name, entry]) => {
      // Skip anything not actively connected — running `gh codespace ssh`
      // against a stopped/erroring codespace can resurrect it.
      if (entry.connection.connectionState !== "connected") return;
      try {
        await this.exec(name, buildUpdateModelScript(model));
      } catch {
        console.warn(`[CodespaceManager] Model update failed for ${name}`);
      }
    });
    await Promise.allSettled(promises);
  }

  private async healthCheck(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry || entry.connection.connectionState !== "connected") return;

    // IMPORTANT: do NOT use `gh codespace ssh -- curl` for health checks.
    // `gh codespace ssh` silently auto-starts a stopped codespace if asked
    // to ssh into one, which can resurrect codespaces the user just shut
    // down. Instead, query the API for the current state — it's
    // authoritative, cheap, and side-effect-free.
    let isAvailable = true;
    try {
      const list = await ghListCodespaces(this.getToken());
      const fresh = list.find((cs) => cs.name === name);
      isAvailable = fresh?.state === "Available";
    } catch (err) {
      // API hiccup — treat as healthy so a transient blip doesn't tear
      // down a working tunnel. The tunnel's own SSH keepalives will detect
      // a real loss within ~45s anyway.
      console.warn(`[CodespaceManager] Health check API call failed for ${name}:`, err);
      isAvailable = true;
    }

    if (!isAvailable) {
      console.log(`[CodespaceManager] ${name} is no longer Available — disconnecting`);
      // Tear down without going through `gh codespace ssh` for remote
      // cleanup (the codespace is gone — exec would either fail or, worse,
      // wake it back up).
      if (entry.healthTimer) clearInterval(entry.healthTimer);
      entry.tunnel.disconnect();
      this.freePort(entry.connection.remotePort);
      const finalConn = updateConnection(entry.connection, {
        connectionState: "available",
      });
      this.connections.delete(name);
      this.emitConnection(finalConn);
      return;
    }

    const updated = updateConnection(entry.connection, { lastHealthCheck: Date.now() });
    this.connections.set(name, { ...entry, connection: updated });
  }

  private async handleUnexpectedDisconnect(name: string, model: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) return;

    // CRITICAL: before any reconnect attempt, verify the codespace is still
    // in `Available` state on GitHub. `gh codespace ssh` will silently
    // *start* a stopped codespace if asked to ssh into one — which is how
    // we ended up auto-resurrecting codespaces the user had just stopped
    // from VS Code or the GitHub web UI. Authoritative state check first.
    let isAvailable = true;
    try {
      const list = await ghListCodespaces(this.getToken());
      const fresh = list.find((cs) => cs.name === name);
      // Treat "not in list" as not available either (deleted codespace).
      isAvailable = fresh?.state === "Available";
    } catch (err) {
      // Network/API failure: be conservative and DO NOT reconnect, since a
      // reconnect could resurrect a stopped codespace. The user can always
      // reconnect manually if they really wanted to stay connected.
      console.warn(`[CodespaceManager] State check failed for ${name}, skipping reconnect:`, err);
      isAvailable = false;
    }

    if (!isAvailable) {
      console.log(`[CodespaceManager] ${name} is no longer Available — cleaning up tunnel without reconnect`);
      // Mirror the disconnect() bookkeeping but skip the remote-cleanup
      // exec (the remote side is gone) and skip the disconnecting/available
      // emit dance so the UI sees a clean removal.
      if (entry.healthTimer) clearInterval(entry.healthTimer);
      entry.tunnel.disconnect();
      this.freePort(entry.connection.remotePort);
      const finalConn = updateConnection(entry.connection, {
        connectionState: "available",
      });
      this.connections.delete(name);
      this.emitConnection(finalConn);
      return;
    }

    if (entry.connection.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      const updated = updateConnection(entry.connection, {
        connectionState: "error",
        errorMessage: "Max reconnect attempts reached",
      });
      this.connections.set(name, { ...entry, connection: updated });
      this.emitConnection(updated);
      this.emit("connectionError", { name, message: updated.errorMessage });
      return;
    }

    let updated = updateConnection(entry.connection, {
      connectionState: "reconnecting",
      reconnectAttempts: entry.connection.reconnectAttempts + 1,
    });
    this.connections.set(name, { ...entry, connection: updated });
    this.emitConnection(updated);

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delay = Math.pow(2, updated.reconnectAttempts - 1) * 1000;
    await new Promise((r) => setTimeout(r, delay));

    try {
      this.freePort(updated.remotePort);
      const newPort = this.allocatePort();
      updated = updateConnection(updated, { remotePort: newPort });

      const tunnel = new SshTunnel(name, newPort, updated.localPort, this.getToken);
      await tunnel.connect();

      // Use the same retry-and-verify path as the initial connect — a
      // reconnect after the codespace was briefly unreachable is exactly
      // when SSH is least cooperative.
      await this.writeRemoteConfigWithRetry(name, newPort, model);

      tunnel.on("unexpectedExit", () => {
        this.handleUnexpectedDisconnect(name, model);
      });

      updated = updateConnection(updated, {
        connectionState: "connected",
        reconnectAttempts: 0,
      });
      this.connections.set(name, { connection: updated, tunnel, healthTimer: entry.healthTimer });
      this.emitConnection(updated);
    } catch {
      updated = updateConnection(updated, {
        connectionState: "error",
        errorMessage: "Reconnection failed",
      });
      this.connections.set(name, { ...entry, connection: updated });
      this.emitConnection(updated);
      this.emit("connectionError", { name, message: "Reconnection failed" });
    }
  }

  private emitConnection(connection: CodespaceConnection): void {
    this.emit("connectionChanged", { ...connection });
  }
}
