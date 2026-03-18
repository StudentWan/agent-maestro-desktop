import React from "react";
import type { ProxyStatus } from "../../shared/types";

interface Props {
  status: ProxyStatus;
  onStart: () => void;
  onStop: () => void;
}

export default function ProxyPanel({ status, onStart, onStop }: Props) {
  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h2 className="text-lg font-semibold mb-3">Proxy Server</h2>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              status.running ? "bg-green-400" : "bg-gray-500"
            }`}
          />
          <span className={status.running ? "text-green-400" : "text-gray-400"}>
            {status.running ? "Running" : "Stopped"}
          </span>
        </div>

        {status.running && (
          <div className="text-sm text-gray-300 space-y-1">
            <p>
              Port: <span className="font-mono">{status.port}</span>
            </p>
            <p>
              Requests served: <span className="font-mono">{status.requestCount}</span>
            </p>
          </div>
        )}

        <div className="flex gap-2">
          {status.running ? (
            <button
              onClick={onStop}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-sm transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={onStart}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-sm transition-colors"
            >
              Start
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
