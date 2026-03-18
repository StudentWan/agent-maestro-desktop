import React, { useState, useCallback } from "react";
import type { AppConfig } from "../../shared/types";

interface Props {
  config: AppConfig;
}

export default function ConfigPanel({ config }: Props) {
  const [showManual, setShowManual] = useState(false);

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  const envBlock = Object.entries(config.envVars)
    .map(([key, value]) => `export ${key}=${value}`)
    .join("\n");

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h2 className="text-lg font-semibold mb-3">Configuration</h2>

      <div className="p-3 bg-gray-900 rounded text-sm">
        <p className="text-green-400">
          Claude Code has been automatically configured.
        </p>
        <p className="text-gray-400 mt-2">
          Just run in your terminal:
        </p>
        <pre className="font-mono text-blue-400 mt-1">claude</pre>
      </div>

      <button
        onClick={() => setShowManual(!showManual)}
        className="mt-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        {showManual ? "Hide manual setup" : "Show manual setup"}
      </button>

      {showManual && (
        <div className="mt-2 relative">
          <pre className="bg-gray-900 rounded p-3 text-sm font-mono text-green-400 overflow-x-auto">
            {envBlock}
          </pre>
          <button
            onClick={() => copyToClipboard(envBlock)}
            className="absolute top-2 right-2 px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs transition-colors"
          >
            Copy
          </button>
        </div>
      )}
    </div>
  );
}
