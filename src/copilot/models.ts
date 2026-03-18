import { EDITOR_VERSION, EDITOR_PLUGIN_VERSION, APP_USER_AGENT, MACHINE_ID } from "../shared/constants";
import type { ModelInfo } from "../shared/types";
import type { TokenManager } from "./token-manager";

const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";

interface CopilotModelEntry {
  id: string;
  name: string;
  version: string;
  capabilities?: {
    type?: string;
  };
  // Other fields we don't need
}

/**
 * Fetch available models from the Copilot API and filter for Claude models
 */
export async function fetchAvailableModels(tokenManager: TokenManager): Promise<ModelInfo[]> {
  const token = await tokenManager.getToken();

  const response = await fetch(COPILOT_MODELS_URL, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "Editor-Version": EDITOR_VERSION,
      "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
      "User-Agent": APP_USER_AGENT,
      "Openai-Organization": "github-copilot",
      "Copilot-Integration-Id": "vscode-chat",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch models (${response.status}): ${body}`);
  }

  const data = await response.json() as { data?: CopilotModelEntry[] };
  const allModels = data.data ?? [];

  // Filter for Claude models only
  const claudeModels = allModels
    .filter((m) => m.id.toLowerCase().includes("claude"))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
    }));

  return claudeModels;
}
