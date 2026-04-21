import React from "react";
import type { AuthStatus } from "../../shared/types";

interface Props {
  status: AuthStatus;
  onLogin: () => void;
  onLogout: () => void;
  onReauthorize: () => void;
}

export default function AuthPanel({ status, onLogin, onLogout, onReauthorize }: Props) {
  const missing = status.missingScopes ?? [];
  const showReauthorize = status.authenticated && missing.length > 0;

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h2 className="text-lg font-semibold mb-3">Authentication</h2>

      {status.authenticated ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            <span className="text-green-400">Connected</span>
          </div>
          {status.username && (
            <p className="text-sm text-gray-300">
              Signed in as <span className="font-mono font-bold">{status.username}</span>
            </p>
          )}

          {showReauthorize && (
            <div className="bg-amber-900/30 border border-amber-600/50 rounded p-3 space-y-2">
              {status.userCode ? (
                <>
                  <p className="text-sm text-amber-200">
                    Enter this code on GitHub to grant access:
                  </p>
                  <div className="bg-gray-900 rounded p-2 text-center">
                    <span className="text-xl font-mono font-bold tracking-widest text-yellow-400">
                      {status.userCode}
                    </span>
                  </div>
                  <p className="text-xs text-amber-300/80">Waiting for authorization...</p>
                </>
              ) : (
                <>
                  <p className="text-sm text-amber-200">
                    Codespace auto-bridge needs additional permissions:
                    {" "}
                    <span className="font-mono text-amber-100">{missing.join(", ")}</span>
                  </p>
                  <button
                    onClick={onReauthorize}
                    className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 rounded text-sm transition-colors"
                  >
                    Grant Codespace Access
                  </button>
                </>
              )}
            </div>
          )}

          <button
            onClick={onLogout}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-sm transition-colors"
          >
            Logout
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-gray-500" />
            <span className="text-gray-400">Not connected</span>
          </div>

          {status.userCode ? (
            <div className="space-y-2">
              <p className="text-sm text-gray-300">
                Enter this code on GitHub:
              </p>
              <div className="bg-gray-900 rounded p-3 text-center">
                <span className="text-2xl font-mono font-bold tracking-widest text-yellow-400">
                  {status.userCode}
                </span>
              </div>
              <p className="text-xs text-gray-400">
                Waiting for authorization...
              </p>
            </div>
          ) : (
            <button
              onClick={onLogin}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm transition-colors"
            >
              Login with GitHub
            </button>
          )}
        </div>
      )}
    </div>
  );
}
