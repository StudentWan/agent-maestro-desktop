import React, { useCallback, useEffect, useState } from "react";
import type { AgentDescriptor, AgentModelInfo } from "../../agents/types";

interface Props {
  agent: AgentDescriptor;
}

const api = window.copilotBridge;

/**
 * Generic per-agent model picker. Replaces the old ModelSelector that was
 * Claude-only. Identical UX, but every IPC call carries the agent id so
 * the same component renders for any future agent without modification.
 */
export default function AgentModelSelector({ agent }: Props) {
  const [models, setModels] = useState<AgentModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.agents.getAvailableModels(agent.id),
      api.agents.getSelectedModel(agent.id),
    ])
      .then(([availableModels, selected]) => {
        setModels(availableModels as AgentModelInfo[]);
        setSelectedModel(selected as string | null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [agent.id]);

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const modelId = e.target.value;
      setSelectedModel(modelId);
      api.agents.setSelectedModel(agent.id, modelId);
    },
    [agent.id],
  );

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-300">Model</h3>
      {loading ? (
        <p className="text-sm text-gray-400">Loading models...</p>
      ) : models.length === 0 ? (
        <p className="text-sm text-gray-500">
          No models available for {agent.displayName}
        </p>
      ) : (
        <>
          <select
            value={selectedModel ?? ""}
            onChange={handleModelChange}
            className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          >
            <option value="" disabled>
              Select a model...
            </option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
          {selectedModel && (
            <p className="text-xs text-gray-500">{agent.modelHint}</p>
          )}
        </>
      )}
    </div>
  );
}
