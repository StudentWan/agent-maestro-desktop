import React, { useState, useEffect, useCallback } from "react";
import AuthPanel from "./components/AuthPanel";
import ProxyPanel from "./components/ProxyPanel";
import TokenCountdown from "./components/TokenCountdown";
import RequestLog from "./components/RequestLog";
import ConfigPanel from "./components/ConfigPanel";
import StatusBar from "./components/StatusBar";
import type { AuthStatus, ProxyStatus, TokenInfo, AppConfig, RequestLogEntry } from "../shared/types";
import type { CopilotBridgeAPI } from "../preload";

declare global {
  interface Window {
    copilotBridge: CopilotBridgeAPI;
  }
}

const api = window.copilotBridge;

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ authenticated: false });
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus>({ running: false, port: 23337, requestCount: 0 });
  const [tokenInfo, setTokenInfo] = useState<TokenInfo>({ token: null, expiresAt: null, remainingSeconds: null });
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [logs, setLogs] = useState<RequestLogEntry[]>([]);

  // Load initial state
  useEffect(() => {
    api.getAuthStatus().then((s: AuthStatus) => setAuthStatus(s));
    api.getProxyStatus().then((s: ProxyStatus) => setProxyStatus(s));
    api.getTokenInfo().then((t: TokenInfo) => setTokenInfo(t));
    api.getConfig().then((c: AppConfig) => setConfig(c));
  }, []);

  // Listen for events from main process
  useEffect(() => {
    const unsubAuth = api.onAuthStatusChanged((s) => setAuthStatus(s as AuthStatus));
    const unsubProxy = api.onProxyStatusChanged((s) => setProxyStatus(s as ProxyStatus));
    const unsubToken = api.onTokenInfoChanged((t) => setTokenInfo(t as TokenInfo));
    const unsubLog = api.onRequestLog((log) => {
      setLogs((prev) => [log as RequestLogEntry, ...prev].slice(0, 100));
    });

    return () => {
      unsubAuth();
      unsubProxy();
      unsubToken();
      unsubLog();
    };
  }, []);

  // Refresh token info periodically
  useEffect(() => {
    if (!authStatus.authenticated) return;
    const interval = setInterval(() => {
      api.getTokenInfo().then((t: TokenInfo) => setTokenInfo(t));
    }, 5000);
    return () => clearInterval(interval);
  }, [authStatus.authenticated]);

  // Refresh config when proxy status changes
  useEffect(() => {
    api.getConfig().then((c: AppConfig) => setConfig(c));
  }, [proxyStatus.running]);

  const handleLogin = useCallback(async () => {
    await api.startLogin();
  }, []);

  const handleLogout = useCallback(async () => {
    await api.logout();
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
          Anthropic API proxy via GitHub Copilot
        </p>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <AuthPanel
            status={authStatus}
            onLogin={handleLogin}
            onLogout={handleLogout}
          />
          <ProxyPanel
            status={proxyStatus}
            onStart={handleStartProxy}
            onStop={handleStopProxy}
          />
        </div>

        {authStatus.authenticated && (
          <TokenCountdown tokenInfo={tokenInfo} />
        )}

        {config && proxyStatus.running && (
          <ConfigPanel config={config} />
        )}

        <RequestLog logs={logs} />
      </main>

      {/* Status bar */}
      <StatusBar authStatus={authStatus} proxyStatus={proxyStatus} />
    </div>
  );
}
