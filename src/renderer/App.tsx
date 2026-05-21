import React, { useState, useEffect, useCallback } from "react";
import AuthPanel from "./components/AuthPanel";
import ProxyPanel from "./components/ProxyPanel";
import SettingsPanel from "./components/SettingsPanel";
import RequestLog from "./components/RequestLog";
import AgentPanel from "./components/AgentPanel";
import StatusBar from "./components/StatusBar";
import CodespacePanel from "./components/CodespacePanel";
import type { AuthStatus, ProxyStatus, AppConfig, RequestLogEntry } from "../shared/types";
import type { AgentDescriptor } from "../agents/types";
import type { CopilotBridgeAPI } from "../preload";

declare global {
  interface Window {
    copilotBridge: CopilotBridgeAPI;
  }
}

const api = window.copilotBridge;

const MAX_LOGS = 200; // 10 pages × 20 per page

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ authenticated: false });
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus>({ running: false, port: 23337, requestCount: 0 });
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [logs, setLogs] = useState<RequestLogEntry[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);

  // Load initial state
  useEffect(() => {
    api.getAuthStatus().then((s: AuthStatus) => setAuthStatus(s));
    api.getProxyStatus().then((s: ProxyStatus) => setProxyStatus(s));
    api.getConfig().then((c: AppConfig) => setConfig(c));
    api.agents.list().then((list) => setAgents(list as AgentDescriptor[]));
  }, []);

  // Listen for events from main process
  useEffect(() => {
    const unsubAuth = api.onAuthStatusChanged((s) => setAuthStatus(s as AuthStatus));
    const unsubProxy = api.onProxyStatusChanged((s) => setProxyStatus(s as ProxyStatus));
    const unsubToken = api.onTokenInfoChanged(() => {
      // Token refresh still happens in background, no UI update needed
    });
    const unsubLog = api.onRequestLog((log) => {
      setLogs((prev) => [log as RequestLogEntry, ...prev].slice(0, MAX_LOGS));
    });

    return () => {
      unsubAuth();
      unsubProxy();
      unsubToken();
      unsubLog();
    };
  }, []);

  // Refresh top-level config when proxy status changes (port may have moved)
  useEffect(() => {
    api.getConfig().then((c: AppConfig) => setConfig(c));
  }, [proxyStatus.running, proxyStatus.port]);

  const handleLogin = useCallback(async () => {
    await api.startLogin();
  }, []);

  const handleLogout = useCallback(async () => {
    await api.logout();
  }, []);

  const handleReauthorize = useCallback(async () => {
    await api.reauthorize();
  }, []);

  const handleStartProxy = useCallback(async () => {
    await api.startProxy();
  }, []);

  const handleStopProxy = useCallback(async () => {
    await api.stopProxy();
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col">
      {/* Header */}
      <header className="px-6 py-4 border-b border-gray-700">
        <h1 className="text-xl font-bold">Agent Maestro Desktop</h1>
        <p className="text-sm text-gray-400 mt-1">
          Coding-agent proxy via GitHub Copilot
        </p>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <AuthPanel
            status={authStatus}
            onLogin={handleLogin}
            onLogout={handleLogout}
            onReauthorize={handleReauthorize}
          />
          <ProxyPanel
            status={proxyStatus}
            onStart={handleStartProxy}
            onStop={handleStopProxy}
          />
        </div>

        {/* Per-agent panels — renders one card per registered agent. */}
        {agents.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {agents.map((agent) => (
              <AgentPanel
                key={agent.id}
                agent={agent}
                authenticated={authStatus.authenticated}
                proxyRunning={proxyStatus.running}
                configReloadKey={config?.proxyPort ?? null}
              />
            ))}
          </div>
        )}

        <SettingsPanel />

        <CodespacePanel authenticated={authStatus.authenticated} />

        <RequestLog logs={logs} />
      </main>

      {/* Status bar */}
      <StatusBar authStatus={authStatus} proxyStatus={proxyStatus} />
    </div>
  );
}
