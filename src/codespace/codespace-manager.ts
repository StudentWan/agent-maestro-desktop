import { EventEmitter } from "node:events";
import { SshTunnel } from "./ssh-tunnel";
import {
  listCodespaces as ghListCodespaces,
  executeRemoteCommand,
  startCodespace as ghStartCodespace,
  probeReverseTunnel,
} from "./gh-cli";
import type { AgentId, AgentPlugin, AgentWriteModelOptions } from "../agents/types";
import { MAX_RECONNECT_ATTEMPTS, MAX_PORT_RETRIES, CODESPACE_HEALTH_CHECK_INTERVAL_MS } from "../shared/constants";
import type {
  CodespaceInfo,
  CodespaceConnection,
  CodespaceConnectionSource,
  CodespaceConnectionProgress,
} from "./types";

const REMOTE_CONFIG_MAX_ATTEMPTS = 4;

/**
 * Snapshot of "what model is selected for each agent right now". Passed
 * into connect()/startAndConnect()/handleUnexpectedDisconnect() so the
 * codespace can be configured for every agent in a single SSH session.
 */
export type AgentModelMap = Readonly<Record<AgentId, string>>;

/**
 * Optional per-agent extras (currently: cached Copilot `max_prompt_tokens`)
 * that ride alongside `AgentModelMap` into connect()/updateModel(). Kept
 * as a separate optional map so callers that don't have the data (auto-
 * bridge, legacy paths) keep working with `undefined`.
 */
export type AgentModelOptionsMap = Readonly<
  Partial<Record<AgentId, AgentWriteModelOptions>>
>;

interface ConnectionEntry {
  readonly connection: CodespaceConnection;
  /**
   * Null while the connection is still being set up (between `connect()`
   * registering the entry and the SSH tunnel actually coming up). Becomes
   * non-null once `tunnel.connect()` has resolved.
   */
  tunnel: SshTunnel | null;
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
  private readonly plugins: readonly AgentPlugin[];

  constructor(
    basePort: number,
    plugins: readonly AgentPlugin[],
    getToken: () => string | undefined = () => undefined,
  ) {
    super();
    this.basePort = basePort;
    this.plugins = plugins;
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
   * Write each agent plugin's remote config (atomic + verified) on the
   * codespace.
   *
   * Per-plugin failure semantics:
   *   - Plugins with `criticalForTunnel: true` (Claude today) → returning
   *     false from this method tears down the tunnel. Preserves today's
   *     "if Claude config didn't land, the proxy is useless, don't lie
   *     about being connected" behaviour.
   *   - Plugins with `criticalForTunnel: false` (Codex, future) → failure
   *     is logged and we move on. Codex is additive; a TOML-write hiccup
   *     must NOT break Claude UX.
   *
   * Returns true iff every critical plugin's config landed.
   */
  private async writeRemoteConfigWithRetry(
    name: string,
    remotePort: number,
    models: AgentModelMap,
    modelOptions: AgentModelOptionsMap | undefined,
    onProgress?: (
      attempt: number,
      phase: "writing-config" | "verifying-config",
      pluginId: AgentId,
    ) => void,
  ): Promise<boolean> {
    let allCriticalLanded = true;
    for (const plugin of this.plugins) {
      const model = models[plugin.id] ?? "";
      if (!model && !plugin.remoteConfig.criticalForTunnel) {
        // Model should have been auto-selected at login — if it's still
        // empty here, the fetch/auto-select likely failed or hasn't run
        // yet. Skip the write to avoid unnecessary SSH commands, but warn
        // so the omission is visible in logs.
        console.warn(
          `[CodespaceManager] Skipping remote config for "${plugin.id}" on ${name} — no model selected (expected auto-select to have run)`,
        );
        continue;
      }
      const landed = await this.writePluginRemoteConfigWithRetry(
        name,
        remotePort,
        model,
        modelOptions?.[plugin.id],
        plugin,
        onProgress,
      );
      if (!landed && plugin.remoteConfig.criticalForTunnel) {
        allCriticalLanded = false;
      } else if (!landed) {
        console.warn(
          `[CodespaceManager] Non-critical agent "${plugin.id}" remote config did not land for ${name} — leaving tunnel up`,
        );
      }
    }
    return allCriticalLanded;
  }

  private async writePluginRemoteConfigWithRetry(
    name: string,
    remotePort: number,
    model: string,
    options: AgentWriteModelOptions | undefined,
    plugin: AgentPlugin,
    onProgress?: (
      attempt: number,
      phase: "writing-config" | "verifying-config",
      pluginId: AgentId,
    ) => void,
  ): Promise<boolean> {
    const attempts = [0, 2_000, 5_000, 10_000]; // 4 attempts: now, +2s, +5s, +10s
    const verifyCommand = plugin.remoteConfig.buildVerifyMarkerCommand();
    for (let i = 0; i < attempts.length; i++) {
      if (attempts[i] > 0) {
        await new Promise((r) => setTimeout(r, attempts[i]));
      }
      try {
        onProgress?.(i + 1, "writing-config", plugin.id);
        await this.exec(name, plugin.remoteConfig.buildWriteScript(remotePort, model, options));
        const post = plugin.remoteConfig.buildPostWriteScript?.();
        if (post) {
          await this.exec(name, post);
        }

        onProgress?.(i + 1, "verifying-config", plugin.id);
        const verify = await this.exec(name, verifyCommand);
        if (parseInt(verify.trim(), 10) > 0) {
          if (i > 0) {
            console.log(
              `[CodespaceManager] Remote config for ${plugin.id} landed on ${name} (attempt ${i + 1})`,
            );
          }
          return true;
        }
        console.warn(
          `[CodespaceManager] Remote config verify failed for ${plugin.id} on ${name} (attempt ${i + 1})`,
        );
      } catch (err) {
        console.warn(
          `[CodespaceManager] Remote config attempt ${i + 1} failed for ${plugin.id} on ${name}:`,
          err,
        );
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

  /**
   * PIDs of all SSH tunnel child processes currently managed by this
   * instance. Used by VsCodeCodespaceDetector to exclude our own tunnels
   * from the process scan — without this, the detector "discovers" our
   * tunnels and keeps the auto-bridge alive even after the user closes
   * VS Code.
   */
  getOwnPids(): ReadonlySet<number> {
    const pids = new Set<number>();
    for (const entry of this.connections.values()) {
      const pid = entry.tunnel?.getPid();
      if (pid != null) pids.add(pid);
    }
    return pids;
  }

  /** Start a shutdown Codespace, then connect to it. */
  async startAndConnect(
    info: CodespaceInfo,
    models: AgentModelMap,
    modelOptions?: AgentModelOptionsMap,
    source: CodespaceConnectionSource = "manual",
  ): Promise<CodespaceConnection> {
    await ghStartCodespace(info.name, this.getToken());
    // Wait a moment for the Codespace to become Available
    await new Promise((r) => setTimeout(r, 5000));
    const updatedInfo: CodespaceInfo = { ...info, state: "Available" };
    return this.connect(updatedInfo, models, modelOptions, source);
  }

  async connect(
    info: CodespaceInfo,
    models: AgentModelMap,
    modelOptions?: AgentModelOptionsMap,
    source: CodespaceConnectionSource = "manual",
  ): Promise<CodespaceConnection> {
    const hasToken = !!this.getToken();
    console.log(
      `[${new Date().toISOString()}] [CodespaceManager] connect() called — ` +
        `codespace=${info.name} state=${info.state} source=${source} ` +
        `hasToken=${hasToken} basePort=${this.basePort} ` +
        `plugins=[${this.plugins.map((p) => p.id).join(",")}]`,
    );

    const existing = this.connections.get(info.name);
    if (existing) {
      // Allow Reconnect after a terminal error: evict the stale entry so
      // the rest of connect() can run cleanly.
      if (existing.connection.connectionState === "error") {
        if (existing.healthTimer) clearInterval(existing.healthTimer);
        existing.tunnel?.disconnect();
        this.freePort(existing.connection.remotePort);
        this.connections.delete(info.name);
      } else {
        throw new Error(`Already connected to ${info.name}`);
      }
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
      progress: { phase: "allocating-port" },
    };

    // Register the entry IMMEDIATELY so `getConnections()` reflects the
    // in-flight connection. Without this, a `refresh()` race during the
    // 0–17s SSH/config phase would return an empty list and the UI would
    // briefly drop the row (showing the "Connect" button again).
    this.connections.set(info.name, {
      connection,
      tunnel: null,
      healthTimer: null,
    });
    this.publish(connection);

    // Port conflict retry loop
    let tunnel: SshTunnel | null = null;
    let portRetries = 0;

    while (portRetries < MAX_PORT_RETRIES) {
      connection = updateConnection(connection, {
        progress: {
          phase: "opening-tunnel",
          attempt: portRetries + 1,
          maxAttempts: MAX_PORT_RETRIES,
          detail: `local :${localPort} → remote :${remotePort}`,
        },
      });
      this.publish(connection);

      tunnel = new SshTunnel(
        info.name,
        remotePort,
        localPort,
        this.getToken,
        // End-to-end readiness probe: verify the reverse port is actually
        // accepting connections inside the codespace before declaring the
        // tunnel "connected". Without this, a fast user who runs `claude`
        // immediately after the UI says "connected" can race the kernel
        // setting up the listening socket and bypass the proxy.
        () => probeReverseTunnel(info.name, remotePort, 25, this.getToken()),
      );

      let portConflict = false;
      tunnel.on("portConflict", (port: number) => {
        console.warn(
          `[${new Date().toISOString()}] [CodespaceManager] portConflict on :${port} for ${info.name}`,
        );
        portConflict = true;
      });

      try {
        console.log(
          `[${new Date().toISOString()}] [CodespaceManager] awaiting tunnel.connect() — ` +
            `local :${localPort} → remote :${remotePort} (attempt ${portRetries + 1}/${MAX_PORT_RETRIES})`,
        );
        await tunnel.connect();
        const tunnelState = tunnel.getState();
        const tunnelPid = tunnel.getPid?.() ?? "(no pid)";
        console.log(
          `[${new Date().toISOString()}] [CodespaceManager] tunnel.connect() resolved — ` +
            `isConnected=${tunnel.isConnected()} state=${tunnelState} pid=${tunnelPid} portConflict=${portConflict}`,
        );
        if (!portConflict && tunnel.isConnected()) break;
        if (!portConflict) {
          // Probe-not-ready / SSH-handshake-not-confirmed path: the process
          // is still alive but the tunnel never proved itself. Tear down so
          // we don't lie to the user about being connected.
          tunnel.disconnect();
          this.freePort(remotePort);
          this.connections.delete(info.name);
          const errConn = updateConnection(connection, {
            connectionState: "error",
            errorCode: "ssh-tunnel-failed",
            errorMessage:
              "SSH tunnel did not become ready within the timeout " +
              "(reverse port forward never accepted connections inside the codespace)",
            progress: undefined,
          });
          this.publish(errConn);
          throw new Error("SSH tunnel did not become ready");
        }
      } catch (err) {
        if (!portConflict) {
          // Drop the placeholder entry before throwing so the UI doesn't
          // see a phantom in-flight row.
          this.connections.delete(info.name);
          this.freePort(remotePort);
          throw err instanceof Error ? err : new Error("SSH tunnel failed to establish");
        }
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
        errorCode: "port-exhausted",
        errorMessage: "Failed to find available port after retries",
        progress: undefined,
      });
      // Keep the entry so the UI can show the error + Reconnect/Dismiss
      // buttons. The `error` state is terminal until the user acts.
      this.publish(connection);
      throw new Error("Failed to find available port after retries");
    }

    // Stash the live tunnel so any access via the map (e.g. disconnect()
    // racing with the rest of connect()) sees the real handle.
    this.updateEntry(info.name, { tunnel });

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
      models,
      modelOptions,
      (attempt, phase, pluginId) => {
        connection = updateConnection(connection, {
          progress: { phase, attempt, maxAttempts: REMOTE_CONFIG_MAX_ATTEMPTS, pluginId },
        });
        this.publish(connection);
      },
    );

    if (!configWritten) {
      // Tear down the half-working connection — leaving it up tricks the
      // user into thinking the proxy is active when it's not.
      console.warn(`[CodespaceManager] Remote config write failed for ${info.name} after retries; tearing down`);
      tunnel.disconnect();
      this.freePort(remotePort);
      connection = updateConnection(connection, {
        connectionState: "error",
        errorCode: "remote-config-failed",
        errorMessage: "Failed to configure Claude Code in codespace (SSH not ready or python3 missing)",
        progress: undefined,
      });
      this.updateEntry(info.name, { tunnel: null });
      this.publish(connection);
      throw new Error("Remote config write failed");
    }

    // Verify the tunnel is still forwarding HTTP traffic after the
    // config-write SSH sessions. Those extra `gh codespace ssh` invocations
    // can occasionally disrupt the long-running tunnel process.
    connection = updateConnection(connection, {
      progress: { phase: "verifying-tunnel" },
    });
    this.publish(connection);

    const tunnelStillUp = await probeReverseTunnel(info.name, remotePort, 5, this.getToken());
    if (!tunnelStillUp) {
      console.warn(
        `[${new Date().toISOString()}] [CodespaceManager] post-config tunnel verification failed ` +
          `for ${info.name} on :${remotePort} — tunnel may have been disrupted by config writes`,
      );
      tunnel.disconnect();
      this.freePort(remotePort);
      connection = updateConnection(connection, {
        connectionState: "error",
        errorCode: "ssh-tunnel-failed",
        errorMessage:
          "SSH tunnel stopped forwarding traffic after remote config was written. " +
          "Click Reconnect to try again.",
        progress: undefined,
      });
      this.updateEntry(info.name, { tunnel: null });
      this.publish(connection);
      throw new Error("Post-config tunnel verification failed");
    }

    // Setup reconnect handler
    tunnel.on("unexpectedExit", () => {
      this.handleUnexpectedDisconnect(info.name, models, modelOptions);
    });

    // Start health check (app-level: curl /health through tunnel)
    connection = updateConnection(connection, {
      progress: { phase: "starting-health-check" },
    });
    this.publish(connection);

    const healthTimer = setInterval(() => {
      this.healthCheck(info.name);
    }, CODESPACE_HEALTH_CHECK_INTERVAL_MS);

    connection = updateConnection(connection, {
      connectionState: "connected",
      connectedAt: Date.now(),
      progress: undefined,
    });

    this.updateEntry(info.name, { tunnel, healthTimer });
    this.publish(connection);

    return { ...connection };
  }

  async disconnect(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) return;

    let connection = updateConnection(entry.connection, {
      connectionState: "disconnecting",
      progress: { phase: "checking-state" },
    });
    this.connections.set(name, { ...entry, connection });
    this.publish(connection);

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
      connection = updateConnection(connection, {
        progress: { phase: "cleaning-remote" },
      });
      this.connections.set(name, { ...entry, connection });
      this.publish(connection);
      // Run every plugin's remove script. Failures are best-effort and
      // logged per plugin so a Codex cleanup hiccup doesn't mask Claude
      // cleanup success (or vice versa).
      for (const plugin of this.plugins) {
        try {
          await this.exec(name, plugin.remoteConfig.buildRemoveScript());
        } catch {
          console.warn(
            `[CodespaceManager] Remote config cleanup failed for ${plugin.id} on ${name}`,
          );
        }
      }
    } else {
      console.log(`[CodespaceManager] Skipping remote cleanup for ${name} — not Available`);
    }

    // Kill tunnel (may be null if disconnect races with a still-setting-up
    // connection — that's fine, the placeholder entry is dropped below).
    entry.tunnel?.disconnect();
    this.freePort(connection.remotePort);

    connection = updateConnection(connection, {
      connectionState: "available",
      progress: undefined,
    });
    this.connections.delete(name);
    this.publish(connection);
  }

  async disconnectAll(): Promise<void> {
    const names = Array.from(this.connections.keys());
    await Promise.allSettled(names.map((name) => this.disconnect(name)));
  }

  /**
   * Evict a terminal-error entry without going through disconnect()'s
   * remote-cleanup dance. Used by the UI's "Dismiss" action — without this,
   * the error entry stays in the map and the next refresh() re-adds it.
   * No-op for non-error entries (use disconnect() instead).
   */
  dismiss(name: string): void {
    const entry = this.connections.get(name);
    if (!entry) return;
    if (entry.connection.connectionState !== "error") return;
    if (entry.healthTimer) clearInterval(entry.healthTimer);
    entry.tunnel?.disconnect();
    this.freePort(entry.connection.remotePort);
    this.connections.delete(name);
    const finalConn = updateConnection(entry.connection, {
      connectionState: "available",
      progress: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    });
    this.publish(finalConn);
  }

  /** Synchronous kill of all SSH processes. Used during app quit. */
  killAllTunnels(): void {
    for (const [, entry] of this.connections) {
      if (entry.healthTimer) clearInterval(entry.healthTimer);
      entry.tunnel?.disconnect();
    }
    this.connections.clear();
    this.allocatedPorts.clear();
  }

  /**
   * Push the new model for the given agent into all currently connected
   * codespaces. Per-agent: callers pass the plugin id and the new model
   * id; the manager picks the matching plugin's `buildUpdateModelScript`
   * and runs it. Other agents on each codespace are not touched.
   */
  async updateModel(
    agentId: AgentId,
    model: string,
    options?: AgentWriteModelOptions,
  ): Promise<void> {
    const plugin = this.plugins.find((p) => p.id === agentId);
    if (!plugin) {
      console.warn(`[CodespaceManager] updateModel: no plugin registered for "${agentId}"`);
      return;
    }
    const promises = Array.from(this.connections.entries()).map(async ([name, entry]) => {
      // Skip anything not actively connected — running `gh codespace ssh`
      // against a stopped/erroring codespace can resurrect it.
      if (entry.connection.connectionState !== "connected") return;
      try {
        await this.exec(name, plugin.remoteConfig.buildUpdateModelScript(model, options));
      } catch {
        console.warn(`[CodespaceManager] Model update failed for ${agentId} on ${name}`);
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
      console.log(
        `[${new Date().toISOString()}] [CodespaceManager] healthCheck(${name}): codespace no longer Available — disconnecting and surfacing as error/codespace-unavailable`,
      );
      // Tear down without going through `gh codespace ssh` for remote
      // cleanup (the codespace is gone — exec would either fail or, worse,
      // wake it back up). Keep the entry in error state so the UI shows a
      // visible reason instead of the row vanishing.
      if (entry.healthTimer) clearInterval(entry.healthTimer);
      entry.tunnel?.disconnect();
      this.freePort(entry.connection.remotePort);
      const finalConn = updateConnection(entry.connection, {
        connectionState: "error",
        errorCode: "codespace-unavailable",
        errorMessage:
          "Codespace is no longer Available (stopped, deleted, or otherwise unreachable). Click Reconnect when ready.",
        progress: undefined,
      });
      this.connections.set(name, { connection: finalConn, tunnel: null, healthTimer: null });
      this.publish(finalConn);
      this.emit("connectionError", { name, message: finalConn.errorMessage! });
      return;
    }

    const updated = updateConnection(entry.connection, { lastHealthCheck: Date.now() });
    this.connections.set(name, { ...entry, connection: updated });
  }

  private async handleUnexpectedDisconnect(
    name: string,
    models: AgentModelMap,
    modelOptions?: AgentModelOptionsMap,
  ): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) {
      console.log(
        `[${new Date().toISOString()}] [CodespaceManager] handleUnexpectedDisconnect(${name}): no entry, ignoring`,
      );
      return;
    }

    console.log(
      `[${new Date().toISOString()}] [CodespaceManager] handleUnexpectedDisconnect(${name}): tunnel died, beginning reconnect flow ` +
        `(prior reconnectAttempts=${entry.connection.reconnectAttempts}, source=${entry.connection.source})`,
    );

    // Mark as reconnecting + checking-state up front so the UI shows
    // something more specific than a stale "connected" while we query
    // GitHub for authoritative state.
    let updated = updateConnection(entry.connection, {
      connectionState: "reconnecting",
      progress: { phase: "checking-state" },
    });
    this.connections.set(name, { ...entry, connection: updated });
    this.publish(updated);

    // CRITICAL: before any reconnect attempt, verify the codespace is still
    // in `Available` state on GitHub. `gh codespace ssh` will silently
    // *start* a stopped codespace if asked to ssh into one — which is how
    // we ended up auto-resurrecting codespaces the user had just stopped
    // from VS Code or the GitHub web UI. Authoritative state check first.
    let isAvailable = true;
    let stateCheckFailed = false;
    let observedState: string | undefined;
    try {
      const list = await ghListCodespaces(this.getToken());
      const fresh = list.find((cs) => cs.name === name);
      observedState = fresh?.state ?? "(not in list)";
      isAvailable = fresh?.state === "Available";
      console.log(
        `[${new Date().toISOString()}] [CodespaceManager] handleUnexpectedDisconnect(${name}): state=${observedState}, isAvailable=${isAvailable}`,
      );
    } catch (err) {
      // Network/API failure: be conservative and DO NOT reconnect, since a
      // reconnect could resurrect a stopped codespace. The user can always
      // reconnect manually if they really wanted to stay connected.
      console.warn(
        `[${new Date().toISOString()}] [CodespaceManager] handleUnexpectedDisconnect(${name}): state check failed, skipping reconnect:`,
        err,
      );
      stateCheckFailed = true;
      isAvailable = false;
    }

    if (!isAvailable) {
      // Previously this branch silently deleted the entry — UI saw the row
      // disappear and the bare "Connect" button reappear with no hint why.
      // Now we leave the entry in a terminal `error` state with a specific
      // errorCode/errorMessage so the user knows what happened and can pick
      // Reconnect or Dismiss.
      const errorCode = stateCheckFailed ? "state-check-failed" : "codespace-unavailable";
      const errorMessage = stateCheckFailed
        ? "GitHub API unreachable while checking codespace state — auto-reconnect skipped to avoid resurrecting a stopped codespace. Click Reconnect when ready."
        : `Codespace state is "${observedState ?? "unknown"}" (not Available) — auto-reconnect skipped to avoid resurrecting a stopped codespace.`;

      console.log(
        `[${new Date().toISOString()}] [CodespaceManager] handleUnexpectedDisconnect(${name}): leaving in error/${errorCode}, NOT auto-reconnecting`,
      );

      // Tear down the tunnel and free the port, but KEEP the entry so the
      // UI can show the failure and offer Reconnect/Dismiss. Don't run
      // remote cleanup via `gh codespace ssh` — it would either fail or,
      // worse, wake the codespace back up.
      if (entry.healthTimer) clearInterval(entry.healthTimer);
      entry.tunnel?.disconnect();
      this.freePort(entry.connection.remotePort);
      const finalConn = updateConnection(entry.connection, {
        connectionState: "error",
        errorCode,
        errorMessage,
        progress: undefined,
      });
      // Drop the live tunnel/healthTimer refs but keep the connection entry
      // so getConnections() and the UI continue to show the row.
      this.connections.set(name, { connection: finalConn, tunnel: null, healthTimer: null });
      this.publish(finalConn);
      this.emit("connectionError", { name, message: errorMessage });
      return;
    }

    if (entry.connection.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      updated = updateConnection(entry.connection, {
        connectionState: "error",
        errorCode: "max-reconnect-reached",
        errorMessage: `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`,
        progress: undefined,
      });
      this.connections.set(name, { ...entry, connection: updated });
      this.publish(updated);
      this.emit("connectionError", { name, message: updated.errorMessage });
      return;
    }

    const nextAttempt = entry.connection.reconnectAttempts + 1;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delaySec = Math.pow(2, nextAttempt - 1);

    updated = updateConnection(entry.connection, {
      connectionState: "reconnecting",
      reconnectAttempts: nextAttempt,
      progress: {
        phase: "waiting-backoff",
        attempt: nextAttempt,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        detail: `${delaySec}s`,
      },
    });
    this.connections.set(name, { ...entry, connection: updated });
    this.publish(updated);

    await new Promise((r) => setTimeout(r, delaySec * 1000));

    try {
      this.freePort(updated.remotePort);
      const newPort = this.allocatePort();
      updated = updateConnection(updated, {
        remotePort: newPort,
        progress: {
          phase: "opening-tunnel",
          attempt: nextAttempt,
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
          detail: `local :${updated.localPort} → remote :${newPort}`,
        },
      });
      this.connections.set(name, { ...entry, connection: updated });
      this.publish(updated);

      const tunnel = new SshTunnel(
        name,
        newPort,
        updated.localPort,
        this.getToken,
        () => probeReverseTunnel(name, newPort, 25, this.getToken()),
      );
      await tunnel.connect();
      if (!tunnel.isConnected()) {
        tunnel.disconnect();
        throw new Error("SSH tunnel did not become ready on reconnect");
      }
      this.updateEntry(name, { tunnel });

      // Use the same retry-and-verify path as the initial connect — a
      // reconnect after the codespace was briefly unreachable is exactly
      // when SSH is least cooperative.
      await this.writeRemoteConfigWithRetry(name, newPort, models, modelOptions, (attempt, phase, pluginId) => {
        updated = updateConnection(updated, {
          progress: { phase, attempt, maxAttempts: REMOTE_CONFIG_MAX_ATTEMPTS, pluginId },
        });
        this.connections.set(name, { ...entry, connection: updated, tunnel });
        this.publish(updated);
      });

      // Post-config tunnel verification (same as initial connect path).
      updated = updateConnection(updated, {
        progress: { phase: "verifying-tunnel" },
      });
      this.connections.set(name, { ...entry, connection: updated, tunnel });
      this.publish(updated);

      const reconnectTunnelOk = await probeReverseTunnel(name, newPort, 5, this.getToken());
      if (!reconnectTunnelOk) {
        throw new Error("Post-config tunnel verification failed on reconnect");
      }

      tunnel.on("unexpectedExit", () => {
        this.handleUnexpectedDisconnect(name, models, modelOptions);
      });

      updated = updateConnection(updated, {
        connectionState: "connected",
        reconnectAttempts: 0,
        progress: undefined,
      });
      this.connections.set(name, { connection: updated, tunnel, healthTimer: entry.healthTimer });
      this.publish(updated);
    } catch {
      updated = updateConnection(updated, {
        connectionState: "error",
        errorCode: "reconnect-failed",
        errorMessage: "Reconnection failed",
        progress: undefined,
      });
      this.connections.set(name, { ...entry, connection: updated });
      this.publish(updated);
      this.emit("connectionError", { name, message: "Reconnection failed" });
    }
  }

  /** Patch the live entry without touching the published connection. */
  private updateEntry(name: string, patch: Partial<ConnectionEntry>): void {
    const entry = this.connections.get(name);
    if (!entry) return;
    this.connections.set(name, { ...entry, ...patch });
  }

  /**
   * Single source of truth for "the connection state changed":
   * 1) update the connection inside the live entry (so getConnections()
   *    returns the latest snapshot and refresh() races don't drop the row)
   * 2) emit so the UI gets the patch immediately.
   */
  private publish(connection: CodespaceConnection): void {
    const entry = this.connections.get(connection.id);
    if (entry) {
      this.connections.set(connection.id, { ...entry, connection });
    }
    this.emit("connectionChanged", { ...connection });
  }
}
