import React from "react";
import type { AuthStatus, ProxyStatus } from "../../shared/types";

interface Props {
  authStatus: AuthStatus;
  proxyStatus: ProxyStatus;
}

export default function StatusBar({ authStatus, proxyStatus }: Props) {
  return (
    <footer className="px-6 py-2 bg-gray-800 border-t border-gray-700 flex items-center justify-between text-xs text-gray-400">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              authStatus.authenticated ? "bg-green-400" : "bg-gray-500"
            }`}
          />
          <span>{authStatus.authenticated ? `${authStatus.username}` : "Not logged in"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              proxyStatus.running ? "bg-green-400" : "bg-gray-500"
            }`}
          />
          <span>
            {proxyStatus.running
              ? `Proxy :${proxyStatus.port}`
              : "Proxy stopped"}
          </span>
        </div>
      </div>
      <span>Agent Maestro Desktop v1.0.0</span>
    </footer>
  );
}
