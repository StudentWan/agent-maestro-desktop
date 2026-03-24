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
import type { CodespaceInfo, CodespaceConnection } from "./types";

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

  constructor(basePort: number) {
    super();
    this.basePort = basePort;
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
    return ghListCodespaces();
  }

  getConnections(): CodespaceConnection[] {
    return Array.from(this.connections.values()).map((e) => ({ ...e.connection }));
  }

  getConnection(name: string): CodespaceConnection | undefined {
    const entry = this.connections.get(name);
    return entry ? { ...entry.connection } : undefined;
  }

  /** Start a shutdown Codespace, then connect to it. */
  async startAndConnect(info: CodespaceInfo, model: string): Promise<CodespaceConnection> {
    await ghStartCodespace(info.name);
    // Wait a moment for the Codespace to become Available
    await new Promise((r) => setTimeout(r, 5000));
    const updatedInfo: CodespaceInfo = { ...info, state: "Available" };
    return this.connect(updatedInfo, model);
  }

  async connect(info: CodespaceInfo, model: string): Promise<CodespaceConnection> {
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
    };

    this.emitConnection(connection);

    // Port conflict retry loop
    let tunnel: SshTunnel | null = null;
    let portRetries = 0;

    while (portRetries < MAX_PORT_RETRIES) {
      tunnel = new SshTunnel(info.name, remotePort, localPort);

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

    // Configure remote Claude Code
    try {
      await executeRemoteCommand(info.name, buildWriteConfigScript(remotePort, model));
      await executeRemoteCommand(info.name, buildWriteOnboardingScript());
    } catch (err) {
      console.warn(`[CodespaceManager] Remote config write failed for ${info.name}:`, err);
      // Non-fatal — tunnel is still up
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

    // Clean remote config (best-effort)
    try {
      await executeRemoteCommand(name, buildRemoveConfigScript());
    } catch {
      console.warn(`[CodespaceManager] Remote config cleanup failed for ${name}`);
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
    const promises = Array.from(this.connections.entries()).map(async ([name]) => {
      try {
        await executeRemoteCommand(name, buildUpdateModelScript(model));
      } catch {
        console.warn(`[CodespaceManager] Model update failed for ${name}`);
      }
    });
    await Promise.allSettled(promises);
  }

  private async healthCheck(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry || entry.connection.connectionState !== "connected") return;

    try {
      await executeRemoteCommand(
        name,
        `curl -sf http://127.0.0.1:${entry.connection.remotePort}/health`,
      );
    } catch {
      console.warn(`[CodespaceManager] Health check failed for ${name}`);
    }

    const updated = updateConnection(entry.connection, { lastHealthCheck: Date.now() });
    this.connections.set(name, { ...entry, connection: updated });
  }

  private async handleUnexpectedDisconnect(name: string, model: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) return;

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

      const tunnel = new SshTunnel(name, newPort, updated.localPort);
      await tunnel.connect();

      try {
        await executeRemoteCommand(name, buildWriteConfigScript(newPort, model));
      } catch {
        // Non-fatal
      }

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
