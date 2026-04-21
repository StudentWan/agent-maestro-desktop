import React, { useState, useEffect, useCallback, useRef } from "react";
import type {
  CodespaceConnection,
  CodespaceConnectionProgress,
  CodespaceErrorCode,
  CodespaceInfo,
  GhCliStatus,
} from "../../codespace/types";
import { KNOWN_CODESPACE_STATES } from "../../codespace/types";

const api = window.copilotBridge;

const POLL_INTERVAL_MS = 60_000; // 60 seconds

interface Props {
  authenticated: boolean;
}

type DisplayItem = {
  info: CodespaceInfo;
  connection?: CodespaceConnection;
};

function stateIcon(state: string | undefined): string {
  switch (state) {
    case "connected": return "🟢";
    case "connecting":
    case "disconnecting":
    case "reconnecting": return "🟡";
    case "error": return "🔴";
    default: return "⚪";
  }
}

function formatUptime(connectedAt: number | null): string {
  if (!connectedAt) return "";
  const seconds = Math.floor((Date.now() - connectedAt) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRelative(ts: number | null): string {
  if (!ts) return "never";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function describeProgress(
  parentState: string | undefined,
  progress: CodespaceConnectionProgress | undefined,
): string {
  if (!progress) {
    if (parentState === "connecting") return "Connecting...";
    if (parentState === "reconnecting") return "Reconnecting...";
    if (parentState === "disconnecting") return "Disconnecting...";
    return "";
  }
  const attemptSuffix =
    progress.attempt && progress.maxAttempts
      ? ` (attempt ${progress.attempt}/${progress.maxAttempts})`
      : "";
  const detailSuffix = progress.detail ? ` — ${progress.detail}` : "";
  switch (progress.phase) {
    case "allocating-port":
      return "Allocating local port...";
    case "opening-tunnel":
      return `Opening SSH tunnel${attemptSuffix}${detailSuffix}`;
    case "writing-config":
      return `Writing remote Claude config${attemptSuffix}`;
    case "verifying-config":
      return `Verifying remote config landed${attemptSuffix}`;
    case "starting-health-check":
      return "Starting health check...";
    case "waiting-backoff":
      return `Reconnect ${progress.attempt}/${progress.maxAttempts} — waiting ${progress.detail ?? ""}...`;
    case "checking-state":
      return parentState === "disconnecting"
        ? "Checking codespace state before cleanup..."
        : "Checking codespace state on GitHub...";
    case "cleaning-remote":
      return "Removing remote config...";
    default:
      return "Working...";
  }
}

function describeError(code: CodespaceErrorCode | undefined): string | null {
  switch (code) {
    case "port-exhausted":
      return "All candidate local ports are busy. Free one and retry.";
    case "remote-config-failed":
      return "Couldn't write Claude config in the codespace (SSH may not be ready, or python3 is missing). Try Reconnect.";
    case "ssh-tunnel-failed":
      return "SSH tunnel didn't come up. Check that the codespace is running and gh CLI is authenticated.";
    case "max-reconnect-reached":
      return "Gave up after several reconnect attempts. Verify the codespace is running on github.com.";
    case "reconnect-failed":
      return "Last reconnect attempt failed. Click Reconnect to try again.";
    default:
      return null;
  }
}

export default function CodespacePanel({ authenticated }: Props) {
  const [ghStatus, setGhStatus] = useState<GhCliStatus | null>(null);
  const [codespaces, setCodespaces] = useState<CodespaceInfo[]>([]);
  const [connections, setConnections] = useState<CodespaceConnection[]>([]);
  const [activeVscode, setActiveVscode] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(new Set());
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true);
    setError(null);
    try {
      const [status, list, conns, active] = await Promise.all([
        api.codespace.checkGhCli(),
        api.codespace.list().catch(() => [] as CodespaceInfo[]),
        api.codespace.getConnections(),
        api.codespace.listActiveVscode().catch(() => [] as string[]),
      ]);
      setGhStatus(status as GhCliStatus);
      setCodespaces(list as CodespaceInfo[]);
      setConnections(conns as CodespaceConnection[]);
      setActiveVscode(active as string[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [authenticated]);

  // Initial load + auto-refresh polling (pause when hidden)
  useEffect(() => {
    refresh();

    const startPolling = () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        refresh();
        startPolling();
      }
    };

    startPolling();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  // Listen for status changes
  useEffect(() => {
    const unsubStatus = api.codespace.onStatusChanged((conn) => {
      const c = conn as CodespaceConnection;
      setConnections((prev) => {
        const existing = prev.findIndex((p) => p.id === c.id);
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = c;
          return next;
        }
        if (c.connectionState !== "available") {
          return [...prev, c];
        }
        return prev.filter((p) => p.id !== c.id);
      });
    });

    const unsubError = api.codespace.onError((err) => {
      const e = err as { name: string; message: string };
      setError(`${e.name}: ${e.message}`);
    });

    return () => {
      unsubStatus();
      unsubError();
    };
  }, []);

  // Tick every 15s so "uptime" / "last health Xs ago" stay fresh without
  // waiting for the 60s poll. Cheap because nothing else re-renders.
  const [, setNow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const toggleDetails = useCallback((name: string) => {
    setExpandedDetails((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleConnect = useCallback(async (name: string) => {
    try {
      setError(null);
      await api.codespace.connect(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleDisconnect = useCallback(async (name: string) => {
    try {
      setError(null);
      await api.codespace.disconnect(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  if (!authenticated) return null;

  // Merge codespaces with connections.
  //
  // Default view: only show codespaces that are either currently open in the
  // local VS Code OR have an active proxy connection. This keeps the panel
  // focused on "what's running right now" instead of dumping the user's
  // entire account inventory. The "Show all" toggle restores the old
  // behavior for cases where the user wants to manually start a stopped
  // codespace.
  const activeNameSet = new Set(activeVscode);
  const connectedNameSet = new Set(connections.map((c) => c.id));
  const filtered = showAll
    ? codespaces
    : codespaces.filter(
        (info) => activeNameSet.has(info.name) || connectedNameSet.has(info.name),
      );

  const items: DisplayItem[] = filtered
    .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
    .map((info) => ({
      info,
      connection: connections.find((c) => c.id === info.name),
    }));

  const hiddenCount = codespaces.length - filtered.length;

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700 col-span-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Codespaces</h2>
        <div className="flex items-center gap-3">
          <label className="text-xs text-gray-400 flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="accent-blue-500"
            />
            Show all
            {!showAll && hiddenCount > 0 && (
              <span className="text-gray-500">({hiddenCount} hidden)</span>
            )}
          </label>
          <button
            onClick={refresh}
            disabled={loading}
            className="text-sm px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* gh CLI status */}
      {ghStatus && (
        <div className="text-sm mb-3 text-gray-400">
          gh CLI:{" "}
          {ghStatus.installed ? (
            <span className="text-green-400">
              v{ghStatus.version}
              {!ghStatus.meetsMinVersion && " (needs >= 2.13.0)"}
              {!ghStatus.authenticated && " | Not authenticated"}
              {ghStatus.authenticated && !ghStatus.hasCodespaceScope && " | Missing codespace scope"}
            </span>
          ) : (
            <span className="text-red-400">
              Not installed —{" "}
              <a href="https://cli.github.com" className="underline text-blue-400" target="_blank" rel="noreferrer">
                Install gh CLI
              </a>
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="text-sm text-red-400 mb-3 bg-red-900/20 p-2 rounded">
          {error}
        </div>
      )}

      {/* Codespace list */}
      {items.length === 0 && !loading && (
        <p className="text-sm text-gray-500">
          {codespaces.length === 0
            ? "No Codespaces found"
            : "No Codespaces are currently open in VS Code. Toggle 'Show all' to see your full inventory."}
        </p>
      )}

      <div className="space-y-2">
        {items.map((item) => {
          const conn = item.connection;
          const connState = conn?.connectionState;
          const isConnected = connState === "connected";
          const isInProgress = connState === "connecting" || connState === "disconnecting" || connState === "reconnecting";
          const isError = connState === "error";
          const isAvailable = item.info.state === KNOWN_CODESPACE_STATES.AVAILABLE;
          const isShutdown = item.info.state === KNOWN_CODESPACE_STATES.SHUTDOWN;
          const isOtherState = !isAvailable && !isShutdown && !connState;
          const errorHint = isError ? describeError(conn?.errorCode) : null;
          const detailsOpen = expandedDetails.has(item.info.name);
          const hasDetails = isError || isConnected;

          return (
            <div key={item.info.name} className={`bg-gray-700/50 rounded p-3 ${isOtherState ? "opacity-50" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>{stateIcon(connState)}</span>
                    <span className="font-mono text-sm truncate">{item.info.displayName}</span>
                    {conn?.source === "vscode-auto" && (
                      <span
                        title="Auto-bridged from VS Code"
                        className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-700/50"
                      >
                        VS Code auto
                      </span>
                    )}
                    {isConnected && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-300 border border-green-700/50">
                        connected
                      </span>
                    )}
                    {isInProgress && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/40 text-yellow-300 border border-yellow-700/50">
                        {connState}
                      </span>
                    )}
                    {isError && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 border border-red-700/50">
                        error{conn?.errorCode ? `: ${conn.errorCode}` : ""}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 mt-1 ml-6">{item.info.repository}</div>

                  {/* In-progress sub-status */}
                  {isInProgress && (
                    <div className="text-xs text-yellow-300/90 mt-1 ml-6">
                      {describeProgress(connState, conn?.progress)}
                    </div>
                  )}

                  {/* Connected: chips */}
                  {isConnected && conn && (
                    <div className="text-xs text-gray-400 mt-1 ml-6 flex flex-wrap gap-x-3 gap-y-1">
                      <span title="local port → remote port">
                        port <span className="text-gray-200 font-mono">:{conn.localPort}</span>
                        {" → "}
                        <span className="text-gray-200 font-mono">:{conn.remotePort}</span>
                      </span>
                      <span title="time since connected">
                        up <span className="text-gray-200">{formatUptime(conn.connectedAt)}</span>
                      </span>
                      <span title="last successful health check">
                        health <span className="text-gray-200">{formatRelative(conn.lastHealthCheck)}</span>
                      </span>
                      {conn.reconnectAttempts > 0 && (
                        <span title="Reconnect attempts since this session started">
                          reconnects <span className="text-gray-200">{conn.reconnectAttempts}</span>
                        </span>
                      )}
                    </div>
                  )}

                  {/* Error: friendly suggestion + raw message */}
                  {isError && (
                    <div className="text-xs mt-1 ml-6">
                      {errorHint && (
                        <div className="text-red-300">{errorHint}</div>
                      )}
                      {conn?.errorMessage && (
                        <div className="text-red-400/80 mt-0.5">{conn.errorMessage}</div>
                      )}
                    </div>
                  )}

                  {/* Other (non-Available/Shutdown) API state */}
                  {!connState && !isAvailable && !isShutdown && (
                    <div className="text-xs text-gray-400 mt-1 ml-6">state: {item.info.state}</div>
                  )}

                  {/* Details disclosure */}
                  {hasDetails && (
                    <button
                      onClick={() => toggleDetails(item.info.name)}
                      className="text-[11px] text-gray-500 hover:text-gray-300 mt-1 ml-6"
                    >
                      {detailsOpen ? "▾ Hide details" : "▸ Show details"}
                    </button>
                  )}
                  {hasDetails && detailsOpen && conn && (
                    <div className="text-[11px] text-gray-500 mt-1 ml-6 font-mono space-y-0.5">
                      <div>id: {conn.id}</div>
                      <div>source: {conn.source}</div>
                      <div>state: {conn.connectionState}</div>
                      {conn.progress && <div>phase: {conn.progress.phase}</div>}
                      {conn.errorCode && <div>errorCode: {conn.errorCode}</div>}
                      <div>reconnectAttempts: {conn.reconnectAttempts}</div>
                      <div>connectedAt: {conn.connectedAt ? new Date(conn.connectedAt).toLocaleString() : "—"}</div>
                      <div>lastHealthCheck: {conn.lastHealthCheck ? new Date(conn.lastHealthCheck).toLocaleString() : "—"}</div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 ml-3 shrink-0">
                  {isConnected && (
                    <button
                      onClick={() => handleDisconnect(item.info.name)}
                      className="text-xs px-3 py-1 bg-red-600 hover:bg-red-500 rounded transition-colors"
                    >
                      Disconnect
                    </button>
                  )}
                  {isError && (
                    <>
                      <button
                        onClick={() => handleConnect(item.info.name)}
                        className="text-xs px-3 py-1 bg-yellow-600 hover:bg-yellow-500 rounded transition-colors"
                      >
                        Reconnect
                      </button>
                      <button
                        onClick={() => {
                          // Tell the manager to evict the entry; without this
                          // the next refresh() would just re-add it.
                          void api.codespace.dismiss(item.info.name);
                          setConnections((prev) => prev.filter((c) => c.id !== item.info.name));
                        }}
                        className="text-xs px-3 py-1 bg-gray-600 hover:bg-gray-500 rounded transition-colors"
                      >
                        Dismiss
                      </button>
                    </>
                  )}
                  {!connState && isAvailable && (
                    <button
                      onClick={() => handleConnect(item.info.name)}
                      className="text-xs px-3 py-1 bg-green-600 hover:bg-green-500 rounded transition-colors"
                    >
                      Connect
                    </button>
                  )}
                  {!connState && isShutdown && (
                    <button
                      onClick={() => handleConnect(item.info.name)}
                      className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded transition-colors"
                    >
                      Start & Connect
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
