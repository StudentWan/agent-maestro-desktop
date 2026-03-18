import React, { useState, useEffect, useCallback } from "react";
import type { ModelInfo } from "../../shared/types";

interface Props {
  authenticated: boolean;
}

const api = window.copilotBridge;

export default function ModelSelector({ authenticated }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Load available models when authenticated
  useEffect(() => {
    if (!authenticated) {
      setModels([]);
      setSelectedModel(null);
      return;
    }

    setLoading(true);
    Promise.all([
      api.getAvailableModels(),
      api.getSelectedModel(),
    ]).then(([availableModels, selected]) => {
      setModels(availableModels as ModelInfo[]);
      setSelectedModel(selected as string | null);
    }).finally(() => {
      setLoading(false);
    });
  }, [authenticated]);

  const handleModelChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const modelId = e.target.value;
    setSelectedModel(modelId);
    api.setSelectedModel(modelId);
  }, []);

  if (!authenticated) return null;

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h2 className="text-lg font-semibold mb-3">Model</h2>
      {loading ? (
        <p className="text-sm text-gray-400">Loading models...</p>
      ) : models.length === 0 ? (
        <p className="text-sm text-gray-500">No Claude models available</p>
      ) : (
        <div className="space-y-2">
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
            <p className="text-xs text-gray-500">
              Claude Code will use this model
            </p>
          )}
        </div>
      )}
    </div>
  );
}
