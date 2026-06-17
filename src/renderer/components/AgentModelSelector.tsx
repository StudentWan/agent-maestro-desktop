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
    let cancelled = false;
    setLoading(true);
    void api.logDiagnostic("info", `Loading models for ${agent.id}`);
    Promise.all([
      api.agents.getAvailableModels(agent.id),
      api.agents.getSelectedModel(agent.id),
    ])
      .then(([availableModels, selected]) => {
        if (cancelled) return;
        const modelList = availableModels as AgentModelInfo[];
        setModels(modelList);
        setSelectedModel(selected as string | null);
        void api.logDiagnostic("info", `Loaded models for ${agent.id}`, {
          count: modelList.length,
          selected,
          selectedInList:
            typeof selected === "string" &&
            modelList.some((model) => model.id === selected),
          modelIds: modelList.map((model) => model.id),
        });
        if (modelList.length === 0) {
          void api.logDiagnostic("warn", `No models available in renderer for ${agent.id}`);
        } else if (
          typeof selected === "string" &&
          selected.length > 0 &&
          !modelList.some((model) => model.id === selected)
        ) {
          void api.logDiagnostic("warn", `Selected model is not present in renderer list for ${agent.id}`, {
            selected,
            modelIds: modelList.map((model) => model.id),
          });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setModels([]);
        void api.logDiagnostic("error", `Failed to load models for ${agent.id}`, message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const modelId = e.target.value;
      setSelectedModel(modelId);
      void api.logDiagnostic("info", `Renderer selected model for ${agent.id}`, modelId);
      void api.agents
        .setSelectedModel(agent.id, modelId)
        .then((savedModelId) => {
          void api.logDiagnostic("info", `Saved selected model for ${agent.id}`, savedModelId);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          void api.logDiagnostic("error", `Failed to set selected model for ${agent.id}`, message);
        });
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
