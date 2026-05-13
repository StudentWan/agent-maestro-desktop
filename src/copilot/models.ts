import {
  APP_USER_AGENT,
  COPILOT_DEFAULT_API_BASE_URL,
  EDITOR_PLUGIN_VERSION,
  EDITOR_VERSION,
} from "../shared/constants";
import type { ModelInfo } from "../shared/types";
import type { TokenManager } from "./token-manager";
import type { CopilotToken } from "./types";

const LEGACY_COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";

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
  const tokenBundle = await resolveTokenBundle(tokenManager);
  const modelsUrl = resolveCopilotModelsUrl(tokenBundle.baseUrl);

  let response = await fetch(modelsUrl, {
    headers: {
      "Authorization": `Bearer ${tokenBundle.token}`,
      "Accept": "application/json",
      "Editor-Version": EDITOR_VERSION,
      "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
      "User-Agent": APP_USER_AGENT,
      "Openai-Organization": "github-copilot",
      "Copilot-Integration-Id": "vscode-chat",
    },
  });

  if (!response.ok && modelsUrl !== LEGACY_COPILOT_MODELS_URL && response.status === 404) {
    response = await fetch(LEGACY_COPILOT_MODELS_URL, {
      headers: {
        "Authorization": `Bearer ${tokenBundle.token}`,
        "Accept": "application/json",
        "Editor-Version": EDITOR_VERSION,
        "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
        "User-Agent": APP_USER_AGENT,
        "Openai-Organization": "github-copilot",
        "Copilot-Integration-Id": "vscode-chat",
      },
    });
  }

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

async function resolveTokenBundle(tokenManager: TokenManager): Promise<Pick<CopilotToken, "token" | "baseUrl">> {
  const provider = tokenManager as TokenManager & {
    getTokenBundle?: () => Promise<CopilotToken>;
  };
  if (typeof provider.getTokenBundle === "function") {
    return provider.getTokenBundle();
  }
  return {
    token: await tokenManager.getToken(),
    baseUrl: COPILOT_DEFAULT_API_BASE_URL,
  };
}

function resolveCopilotModelsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/models`;
}
