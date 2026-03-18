import { v4 as uuidv4 } from "uuid";
import {
  APP_USER_AGENT,
  EDITOR_VERSION,
  EDITOR_PLUGIN_VERSION,
  MACHINE_ID,
} from "../shared/constants";

/**
 * Build the required headers for Copilot API requests
 */
export function buildCopilotHeaders(copilotToken: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${copilotToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Accept-Encoding": "gzip, deflate, br",
    "Editor-Version": EDITOR_VERSION,
    "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
    "User-Agent": APP_USER_AGENT,
    "X-Request-Id": uuidv4(),
    "Openai-Organization": "github-copilot",
    "Openai-Intent": "conversation-panel",
    "VScode-SessionId": uuidv4(),
    "VScode-MachineId": MACHINE_ID,
    "Copilot-Integration-Id": "vscode-chat",
  };
}

/**
 * Build headers for streaming requests
 */
export function buildCopilotStreamHeaders(copilotToken: string): Record<string, string> {
  return {
    ...buildCopilotHeaders(copilotToken),
    "Accept": "text/event-stream",
  };
}
