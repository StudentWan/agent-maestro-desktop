import React, { useState, useEffect, useCallback } from "react";

const api = window.copilotBridge;

export default function SettingsPanel() {
  const [autoStart, setAutoStart] = useState(false);
  const [savingLog, setSavingLog] = useState(false);
  const [logSaveMessage, setLogSaveMessage] = useState<string | null>(null);

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

  const handleSaveDiagnosticLog = useCallback(async () => {
    setSavingLog(true);
    setLogSaveMessage(null);
    try {
      const result = await api.saveDiagnosticLog();
      if (result?.canceled) {
        setLogSaveMessage("Save canceled");
      } else if (result?.error) {
        setLogSaveMessage(`Could not save logs: ${result.error}`);
      } else {
        setLogSaveMessage("Diagnostic logs saved");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLogSaveMessage(`Could not save logs: ${message}`);
      void api.logDiagnostic("error", "Failed to save diagnostic logs from SettingsPanel", message);
    } finally {
      setSavingLog(false);
    }
  }, []);

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h2 className="text-lg font-semibold mb-3">Settings</h2>
      <div className="space-y-4">
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
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-gray-700 pt-4">
          <div className="min-w-0">
            <p className="text-sm text-gray-300">Diagnostic logs</p>
            <p className="text-xs text-gray-500">Save runtime logs to share with support</p>
            {logSaveMessage && (
              <p className="text-xs text-gray-400 mt-1">{logSaveMessage}</p>
            )}
          </div>
          <button
            onClick={handleSaveDiagnosticLog}
            disabled={savingLog}
            className="self-start sm:self-auto px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
          >
            {savingLog ? "Saving..." : "Save logs"}
          </button>
        </div>
      </div>
    </div>
  );
}
