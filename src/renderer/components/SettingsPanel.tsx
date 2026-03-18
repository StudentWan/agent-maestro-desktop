import React, { useState, useEffect, useCallback } from "react";

const api = window.copilotBridge;

export default function SettingsPanel() {
  const [autoStart, setAutoStart] = useState(false);

  useEffect(() => {
    api.getAutoStart().then((enabled: boolean) => {
      setAutoStart(enabled);
    });
  }, []);

  const handleToggleAutoStart = useCallback(() => {
    const newValue = !autoStart;
    setAutoStart(newValue);
    api.setAutoStart(newValue);
  }, [autoStart]);

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h2 className="text-lg font-semibold mb-3">Settings</h2>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-300">Start on boot</p>
          <p className="text-xs text-gray-500">Launch automatically when you log in</p>
        </div>
        <button
          onClick={handleToggleAutoStart}
          className={`relative w-11 h-6 rounded-full transition-colors ${
            autoStart ? "bg-blue-600" : "bg-gray-600"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              autoStart ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>
    </div>
  );
}
