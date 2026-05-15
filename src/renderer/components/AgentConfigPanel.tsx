import React, { useCallback, useEffect, useState } from "react";
import type { AgentAppConfig, AgentDescriptor } from "../../agents/types";

interface Props {
  agent: AgentDescriptor;
  /**
   * Reload the snippet whenever this changes. Plumbed in from the parent so
   * "proxy started" / "proxy port changed" reactivity stays at the panel
   * level (this component is otherwise stateless beyond its own fetch).
   */
  reloadKey?: unknown;
}

const api = window.copilotBridge;

/**
 * Generic per-agent config snippet panel. Renders:
 *   - the env-var block (if the agent reports any) with a copy button
 *   - the file snippet (if `agent.hasFileSnippet`) with a label and copy
 *
 * The renderer never reaches into agent-specific code — everything comes
 * back from `agents:get-config`. So Claude shows env-only, Codex shows
 * env-empty + a TOML block, and any future agent slots in the same way.
 */
export default function AgentConfigPanel({ agent, reloadKey }: Props) {
  const [config, setConfig] = useState<AgentAppConfig | null>(null);
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.agents.getConfig(agent.id).then((c) => {
      if (cancelled) return;
      setConfig((c as AgentAppConfig) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [agent.id, reloadKey]);

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  if (!config) {
    return null;
  }

  const envEntries = Object.entries(config.snippet.envVars);
  const envBlock = envEntries
    .map(([key, value]) => `export ${key}=${value}`)
    .join("\n");

  return (
    <div className="space-y-3">
      <div className="p-3 bg-gray-900 rounded text-sm">
        <p className="text-green-400">
          {agent.displayName} has been automatically configured.
        </p>
        <p className="text-gray-400 mt-2">
          Base URL:{" "}
          <code className="font-mono text-blue-400">{config.baseUrl}</code>
        </p>
      </div>

      {(envEntries.length > 0 || config.snippet.file) && (
        <button
          onClick={() => setShowManual(!showManual)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {showManual ? "Hide manual setup" : "Show manual setup"}
        </button>
      )}

      {showManual && envEntries.length > 0 && (
        <div className="relative">
          {config.snippet.envLabel && (
            <p className="text-xs text-gray-400 mb-1">{config.snippet.envLabel}</p>
          )}
          <pre className="bg-gray-900 rounded p-3 text-sm font-mono text-green-400 overflow-x-auto">
            {envBlock}
          </pre>
          <button
            onClick={() => copyToClipboard(envBlock)}
            className="absolute top-7 right-2 px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs transition-colors"
          >
            Copy
          </button>
        </div>
      )}

      {showManual && config.snippet.file && (
        <div className="relative">
          <p className="text-xs text-gray-400 mb-1">
            {config.snippet.file.path} (auto-managed)
          </p>
          <pre className="bg-gray-900 rounded p-3 text-sm font-mono text-yellow-300 overflow-x-auto">
            {config.snippet.file.content}
          </pre>
          <button
            onClick={() => copyToClipboard(config.snippet.file!.content)}
            className="absolute top-7 right-2 px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs transition-colors"
          >
            Copy
          </button>
        </div>
      )}
    </div>
  );
}
