import {
  APP_USER_AGENT,
  COPILOT_DEFAULT_API_BASE_URL,
  EDITOR_PLUGIN_VERSION,
  EDITOR_VERSION,
} from "../../shared/constants";
import type { TokenManager } from "../../copilot/token-manager";
import type { CopilotToken } from "../../copilot/types";
import type { AgentModelInfo } from "../types";

const LEGACY_COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";

export interface CopilotModelEntry {
  id: string;
  name: string;
  version: string;
  capabilities?: {
    type?: string;
    supports?: {
      reasoning_effort?: string[];
    };
  };
  // Other fields we don't need
}

/**
 * Fetch available models from the Copilot API and filter for Claude models
 */
export async function fetchAvailableModels(tokenManager: TokenManager): Promise<AgentModelInfo[]> {
  const tokenBundle = await resolveTokenBundle(tokenManager);
  const allModels = await fetchCopilotModelEntries(tokenBundle);

  // Filter for Claude models that the Copilot Anthropic Messages endpoint accepts.
  const claudeModels = allModels
    .filter((m) => isSupportedCopilotClaudeModel(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
    }));

  return claudeModels;
}

export async function fetchCopilotModelEntries(
  tokenBundle: Pick<CopilotToken, "token" | "baseUrl">,
): Promise<CopilotModelEntry[]> {
  const modelsUrl = resolveCopilotModelsUrl(tokenBundle.baseUrl);

  let response = await fetchCopilotModels(modelsUrl, tokenBundle.token);

  if (!response.ok && modelsUrl !== LEGACY_COPILOT_MODELS_URL && response.status === 404) {
    response = await fetchCopilotModels(LEGACY_COPILOT_MODELS_URL, tokenBundle.token);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch models (${response.status}): ${body}`);
  }

  const data = await response.json() as { data?: CopilotModelEntry[] };
  return data.data ?? [];
}

function fetchCopilotModels(url: string, token: string): Promise<Response> {
  return fetch(url, {
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

function isSupportedCopilotClaudeModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes("claude") && normalized !== "claude-sonnet-4-6-1m";
}
