export type IpcChannels =
  | "auth:start-login"
  | "auth:reauthorize"
  | "auth:logout"
  | "auth:get-status"
  | "proxy:start"
  | "proxy:stop"
  | "proxy:get-status"
  | "token:get-info"
  | "config:get"
  // ---- Per-agent (parametric) ----
  // List every registered agent { id, displayName, slug, hasFileSnippet, modelHint }
  | "agents:list"
  // Get the model list this agent supports (filtered Copilot models)
  | "agents:get-available-models"
  // Get/set the user-selected model for one agent
  | "agents:get-selected-model"
  | "agents:set-selected-model"
  // Get the agent-specific config snippet (env vars + optional file) for the AgentConfigPanel
  | "agents:get-config"
  // ---- Settings ----
  | "settings:get-auto-start"
  | "settings:set-auto-start"
  // ---- Codespace ----
  | "codespace:check-gh-cli"
  | "codespace:list"
  | "codespace:list-active-vscode"
  | "codespace:connect"
  | "codespace:disconnect"
  | "codespace:disconnect-all"
  | "codespace:dismiss"
  | "codespace:get-connections";

export type IpcEvents =
  | "auth:status-changed"
  | "proxy:status-changed"
  | "token:info-changed"
  | "proxy:request-log"
  | "codespace:status-changed"
  | "codespace:connection-error";
