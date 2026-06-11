import React, { useState, useMemo, useCallback } from "react";
import type { RequestLogEntry } from "../../shared/types";

const PAGE_SIZE = 20;

interface Props {
  logs: RequestLogEntry[];
}

function hasDetails(log: RequestLogEntry): boolean {
  return Boolean(log.upstreamError) || Boolean(log.error);
}

export default function RequestLog({ logs }: Props) {
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  const totalPages = Math.max(1, Math.ceil(logs.length / PAGE_SIZE));

  // Clamp current page if logs shrink
  const safePage = Math.min(currentPage, totalPages);
  if (safePage !== currentPage) {
    setCurrentPage(safePage);
  }

  const pagedLogs = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return logs.slice(start, start + PAGE_SIZE);
  }, [logs, safePage]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const copyBody = useCallback((body: string) => {
    void navigator.clipboard?.writeText(body);
  }, []);

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
              <th className="text-left py-2 pr-4 w-6"></th>
              <th className="text-left py-2 pr-4">Time</th>
              <th className="text-left py-2 pr-4">Model / Request</th>
              <th className="text-left py-2 pr-4">Thinking</th>
              <th className="text-left py-2 pr-4">Status</th>
              <th className="text-left py-2 pr-4">Duration</th>
              <th className="text-left py-2 pr-4">Stream</th>
            </tr>
          </thead>
          <tbody>
            {pagedLogs.map((log) => {
              const expandable = hasDetails(log);
              const expanded = expandable && expandedIds.has(log.id);
              return (
                <React.Fragment key={log.id}>
                  <tr
                    className={`border-b border-gray-700/50 ${
                      expandable ? "cursor-pointer hover:bg-gray-700/30" : ""
                    }`}
                    onClick={expandable ? () => toggleExpanded(log.id) : undefined}
                  >
                    <td className="py-2 pr-4 text-xs text-gray-500 select-none">
                      {expandable ? (expanded ? "▼" : "▶") : ""}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{log.model}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{log.thinkingLevel ?? "-"}</td>
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
                  {expanded && (
                    <tr className="border-b border-gray-700/50 bg-gray-900/40">
                      <td colSpan={7} className="py-3 px-4">
                        <ErrorDetails log={log} onCopy={copyBody} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-700">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
            className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors"
          >
            Previous
          </button>
          <span className="text-xs text-gray-400">
            Page {safePage} / {totalPages}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage >= totalPages}
            className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

interface ErrorDetailsProps {
  log: RequestLogEntry;
  onCopy: (body: string) => void;
}

function ErrorDetails({ log, onCopy }: ErrorDetailsProps) {
  const upstream = log.upstreamError;
  return (
    <div className="space-y-2">
      {upstream && (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-gray-400">
              Upstream HTTP <span className="font-mono text-red-400">{upstream.status}</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCopy(upstream.body);
              }}
              className="px-2 py-0.5 text-xs bg-gray-700 hover:bg-gray-600 rounded transition-colors"
            >
              Copy body
            </button>
          </div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs font-mono bg-gray-950/60 border border-gray-700 rounded p-2 text-gray-200">
            {upstream.body || "(empty body)"}
          </pre>
        </>
      )}
      {!upstream && log.error && (
        <>
          <div className="text-xs text-gray-400">Error</div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs font-mono bg-gray-950/60 border border-gray-700 rounded p-2 text-gray-200">
            {log.error}
          </pre>
        </>
      )}
    </div>
  );
}
