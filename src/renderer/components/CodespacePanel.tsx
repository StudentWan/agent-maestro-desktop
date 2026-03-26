import React, { useState, useEffect, useCallback, useRef } from "react";
import type { CodespaceConnection, CodespaceInfo, GhCliStatus, AutoDetectState, DetectedCodespace } from "../../codespace/types";
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

export default function CodespacePanel({ authenticated }: Props) {
  const [ghStatus, setGhStatus] = useState<GhCliStatus | null>(null);
  const [codespaces, setCodespaces] = useState<CodespaceInfo[]>([]);
  const [connections, setConnections] = useState<CodespaceConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoDetectState, setAutoDetectState] = useState<AutoDetectState | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true);
    setError(null);
    try {
      const [status, list, conns, adState] = await Promise.all([
        api.codespace.checkGhCli(),
        api.codespace.list().catch(() => [] as CodespaceInfo[]),
        api.codespace.getConnections(),
        api.autoDetect.getState().catch(() => null),
      ]);
      setGhStatus(status as GhCliStatus);
      setCodespaces(list as CodespaceInfo[]);
      setConnections(conns as CodespaceConnection[]);
      if (adState) setAutoDetectState(adState as AutoDetectState);
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

    // Auto-detect events
    const unsubAutoConnected = api.autoDetect.onAutoConnected(() => {
      api.autoDetect.getState().then((s) => setAutoDetectState(s as AutoDetectState)).catch(() => {});
      refresh();
    });
    const unsubScopeRequired = api.autoDetect.onScopeRequired(() => {
      api.autoDetect.getState().then((s) => setAutoDetectState(s as AutoDetectState)).catch(() => {});
    });
    const unsubAutoDisconnected = api.autoDetect.onAutoDisconnected(() => {
      api.autoDetect.getState().then((s) => setAutoDetectState(s as AutoDetectState)).catch(() => {});
      refresh();
    });
    const unsubAutoError = api.autoDetect.onAutoConnectError((err) => {
      const e = err as { name: string; message: string };
      setError(`Auto-connect failed for ${e.name}: ${e.message}`);
    });

    return () => {
      unsubStatus();
      unsubError();
      unsubAutoConnected();
      unsubScopeRequired();
      unsubAutoDisconnected();
      unsubAutoError();
    };
  }, [refresh]);

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

  const handleToggleAutoDetect = useCallback(async () => {
    try {
      setError(null);
      const isEnabled = autoDetectState?.config.enabled ?? false;
      if (isEnabled) {
        await api.autoDetect.setConfig({ enabled: false });
        await api.autoDetect.stop();
      } else {
        await api.autoDetect.setConfig({ enabled: true });
        await api.autoDetect.start();
      }
      const newState = await api.autoDetect.getState();
      setAutoDetectState(newState as AutoDetectState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [autoDetectState]);

  const handleToggleAutoDisconnect = useCallback(async () => {
    try {
      const current = autoDetectState?.config.autoDisconnectOnClose ?? false;
      await api.autoDetect.setConfig({ autoDisconnectOnClose: !current });
      const newState = await api.autoDetect.getState();
      setAutoDetectState(newState as AutoDetectState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [autoDetectState]);

  const handleGrantScope = useCallback(() => {
    // Open terminal instruction — user needs to run: gh auth refresh -s codespace
    setError("Please run: gh auth refresh -h github.com -s codespace — then click Retry below");
  }, []);

  const handleRetryScope = useCallback(async () => {
    try {
      setError(null);
      await api.autoDetect.retryScopeConnections();
      const newState = await api.autoDetect.getState();
      setAutoDetectState(newState as AutoDetectState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  if (!authenticated) return null;

  // Merge codespaces with connections
  const items: DisplayItem[] = codespaces
    .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
    .map((info) => ({
      info,
      connection: connections.find((c) => c.id === info.name),
    }));

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700 col-span-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Codespaces</h2>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-sm px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
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

      {/* Auto-Detection controls */}
      <div className="mb-3 bg-gray-700/30 rounded p-3 border border-gray-600">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium">Auto-detect VS Code Codespaces</span>
          <button
            onClick={handleToggleAutoDetect}
            className={`text-xs px-3 py-1 rounded transition-colors ${
              autoDetectState?.config.enabled
                ? "bg-green-600 hover:bg-green-500"
                : "bg-gray-600 hover:bg-gray-500"
            }`}
          >
            {autoDetectState?.config.enabled ? "ON" : "OFF"}
          </button>
        </div>
        {autoDetectState?.config.enabled && (
          <>
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={autoDetectState.config.autoDisconnectOnClose}
                onChange={handleToggleAutoDisconnect}
                className="rounded"
              />
              Auto-disconnect when VS Code window closes
            </label>
            {autoDetectState.detectedCodespaces.length > 0 && (
              <div className="mt-2 text-xs text-gray-400">
                Detected: {autoDetectState.detectedCodespaces.map((cs: DetectedCodespace) => cs.name).join(", ")}
              </div>
            )}
            {autoDetectState.pendingScopeCodespaces.length > 0 && (
              <div className="mt-2 p-2 bg-yellow-900/30 rounded border border-yellow-700">
                <p className="text-xs text-yellow-300 mb-1">
                  {autoDetectState.pendingScopeCodespaces.length} codespace(s) need the &quot;codespace&quot; OAuth scope to auto-connect:
                </p>
                <p className="text-xs text-gray-400 mb-2">
                  {autoDetectState.pendingScopeCodespaces.map((cs: DetectedCodespace) => cs.name).join(", ")}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleGrantScope}
                    className="text-xs px-3 py-1 bg-yellow-600 hover:bg-yellow-500 rounded transition-colors"
                  >
                    How to grant scope
                  </button>
                  <button
                    onClick={handleRetryScope}
                    className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded transition-colors"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <div className="text-sm text-red-400 mb-3 bg-red-900/20 p-2 rounded">
          {error}
        </div>
      )}

      {/* Codespace list */}
      {items.length === 0 && !loading && (
        <p className="text-sm text-gray-500">No Codespaces found</p>
      )}

      <div className="space-y-2">
        {items.map((item) => {
          const connState = item.connection?.connectionState;
          const isConnected = connState === "connected";
          const isInProgress = connState === "connecting" || connState === "disconnecting" || connState === "reconnecting";
          const isError = connState === "error";
          const isAvailable = item.info.state === KNOWN_CODESPACE_STATES.AVAILABLE;
          const isShutdown = item.info.state === KNOWN_CODESPACE_STATES.SHUTDOWN;
          const isOtherState = !isAvailable && !isShutdown && !connState;

          return (
            <div key={item.info.name} className={`bg-gray-700/50 rounded p-3 ${isOtherState ? "opacity-50" : ""}`}>
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span>{stateIcon(connState)}</span>
                    <span className="font-mono text-sm truncate">{item.info.displayName}</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-1 ml-6">
                    {item.info.repository}
                    {isConnected && item.connection?.connectedAt && (
                      <span className="ml-2">
                        | port: {item.connection.remotePort} → {item.connection.localPort}
                        | uptime: {formatUptime(item.connection.connectedAt)}
                      </span>
                    )}
                    {isError && item.connection?.errorMessage && (
                      <span className="text-red-400 ml-2">| {item.connection.errorMessage}</span>
                    )}
                    {!connState && !isAvailable && (
                      <span className="ml-2">| {item.info.state}</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 ml-3">
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
                        onClick={() => setConnections((prev) => prev.filter((c) => c.id !== item.info.name))}
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
                  {isInProgress && (
                    <span className="text-xs text-yellow-400 px-3 py-1">
                      {connState === "connecting" ? "Connecting..." : connState === "disconnecting" ? "Disconnecting..." : "Reconnecting..."}
                    </span>
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
