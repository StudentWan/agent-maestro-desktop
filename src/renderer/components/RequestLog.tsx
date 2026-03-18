import React from "react";
import type { RequestLogEntry } from "../../shared/types";

interface Props {
  logs: RequestLogEntry[];
}

export default function RequestLog({ logs }: Props) {
  if (logs.length === 0) {
    return (
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h2 className="text-lg font-semibold mb-3">Request Log</h2>
        <p className="text-sm text-gray-500">No requests yet</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h2 className="text-lg font-semibold mb-3">
        Request Log ({logs.length})
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 border-b border-gray-700">
              <th className="text-left py-2 pr-4">Time</th>
              <th className="text-left py-2 pr-4">Model</th>
              <th className="text-left py-2 pr-4">Status</th>
              <th className="text-left py-2 pr-4">Duration</th>
              <th className="text-left py-2 pr-4">Stream</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                <td className="py-2 pr-4 font-mono text-xs">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </td>
                <td className="py-2 pr-4 font-mono text-xs">{log.model}</td>
                <td className="py-2 pr-4">
                  <span
                    className={`text-xs font-mono ${
                      log.status < 400 ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    {log.status}
                  </span>
                </td>
                <td className="py-2 pr-4 font-mono text-xs">
                  {log.durationMs}ms
                </td>
                <td className="py-2 pr-4 text-xs">
                  {log.stream ? "Yes" : "No"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
