import React from "react";
import type { AgentDescriptor } from "../../agents/types";
import AgentConfigPanel from "./AgentConfigPanel";
import AgentModelSelector from "./AgentModelSelector";

interface Props {
  agent: AgentDescriptor;
  authenticated: boolean;
  proxyRunning: boolean;
  /** Bumped whenever the proxy port changes so the snippet re-fetches. */
  configReloadKey: unknown;
}

/**
 * One panel per agent. Shows:
 *   - the model selector (when authenticated)
 *   - the config snippet (when proxy is running so the URL is stable)
 *
 * Renders nothing until authenticated — the model list and config snippet
 * both depend on `agents:*` IPC handlers that need the Copilot client.
 */
export default function AgentPanel({
  agent,
  authenticated,
  proxyRunning,
  configReloadKey,
}: Props) {
  if (!authenticated) {
    return (
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h2 className="text-lg font-semibold mb-1">{agent.displayName}</h2>
        <p className="text-sm text-gray-500">
          Log in to configure {agent.displayName}.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700 space-y-4">
      <h2 className="text-lg font-semibold">{agent.displayName}</h2>
      <AgentModelSelector agent={agent} />
      {proxyRunning && (
        <AgentConfigPanel agent={agent} reloadKey={configReloadKey} />
      )}
    </div>
  );
}
