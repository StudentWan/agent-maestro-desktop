import React from "react";
import type { TokenInfo } from "../../shared/types";

interface Props {
  tokenInfo: TokenInfo;
}

export default function TokenCountdown({ tokenInfo }: Props) {
  if (!tokenInfo.remainingSeconds) return null;

  const remaining = tokenInfo.remainingSeconds;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  const isLow = remaining < 120;
  const color = isLow ? "text-yellow-400" : "text-green-400";

  // Progress bar (30 min = 1800s)
  const progress = Math.min((remaining / 1800) * 100, 100);

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h2 className="text-lg font-semibold mb-3">Copilot Token</h2>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">Expires in</span>
          <span className={`font-mono text-lg ${color}`}>
            {minutes}:{seconds.toString().padStart(2, "0")}
          </span>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-gray-700 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all ${
              isLow ? "bg-yellow-400" : "bg-green-400"
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>

        <p className="text-xs text-gray-500">
          Auto-refreshes every 25 minutes
        </p>
      </div>
    </div>
  );
}
