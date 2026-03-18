import React, { useCallback } from "react";
import type { AppConfig } from "../../shared/types";

interface Props {
  config: AppConfig;
}

export default function ConfigPanel({ config }: Props) {
  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  const envBlock = Object.entries(config.envVars)
    .map(([key, value]) => `export ${key}=${value}`)
    .join("\n");

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h2 className="text-lg font-semibold mb-3">Configuration</h2>
      <p className="text-sm text-gray-400 mb-3">
        Set these environment variables to use Claude Code with this proxy:
      </p>

      <div className="relative">
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

      <div className="mt-3 p-3 bg-gray-900 rounded text-sm">
        <p className="text-gray-400">Then run:</p>
        <pre className="font-mono text-blue-400 mt-1">claude</pre>
      </div>
    </div>
  );
}
