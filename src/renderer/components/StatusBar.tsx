import React from "react";
import type { AuthStatus, ProxyStatus } from "../../shared/types";

interface Props {
  authStatus: AuthStatus;
  proxyStatus: ProxyStatus;
  appVersion: string;
}

export default function StatusBar({ authStatus, proxyStatus, appVersion }: Props) {
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
      <span>Agent Maestro Desktop {formatVersion(appVersion)}</span>
    </footer>
  );
}

function formatVersion(version: string): string {
  if (version === "local") return "local";
  // Pre-pend `v` only when the upstream string is a bare semver-ish version.
  // The release workflow strips a leading `v` before writing package.json,
  // so we always re-add it here for visual consistency.
  return version.startsWith("v") ? version : `v${version}`;
}
