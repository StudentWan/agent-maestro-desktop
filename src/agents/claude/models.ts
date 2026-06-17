import {
  APP_USER_AGENT,
  COPILOT_DEFAULT_API_BASE_URL,
  EDITOR_PLUGIN_VERSION,
  EDITOR_VERSION,
} from "../../shared/constants";
import type { TokenManager } from "../../copilot/token-manager";
import type { CopilotToken } from "../../copilot/types";
import { truncateUpstreamBody } from "../../copilot/upstream-error";
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

  console.info(
    `[Claude Models] Filtered ${claudeModels.length} Claude model(s) from ${allModels.length} Copilot model(s)` +
      formatModelPreview(claudeModels.map((m) => m.id)),
  );

  return claudeModels;
}

export async function fetchCopilotModelEntries(
  tokenBundle: Pick<CopilotToken, "token" | "baseUrl">,
): Promise<CopilotModelEntry[]> {
  const modelsUrl = resolveCopilotModelsUrl(tokenBundle.baseUrl);

  console.info(`[Copilot Models] Fetching model catalog: ${modelsUrl}`);
  let response = await fetchCopilotModels(modelsUrl, tokenBundle.token);
  console.info(`[Copilot Models] ${modelsUrl} responded with HTTP ${response.status}`);

  if (!response.ok && modelsUrl !== LEGACY_COPILOT_MODELS_URL && response.status === 404) {
    console.warn(
      `[Copilot Models] ${modelsUrl} returned 404; retrying legacy endpoint ${LEGACY_COPILOT_MODELS_URL}`,
    );
    response = await fetchCopilotModels(LEGACY_COPILOT_MODELS_URL, tokenBundle.token);
    console.info(`[Copilot Models] ${LEGACY_COPILOT_MODELS_URL} responded with HTTP ${response.status}`);
  }

  if (!response.ok) {
    const body = await response.text();
    console.error(`[Copilot Models] Failed to fetch model catalog (${response.status}):`, body);
    throw new Error(`Failed to fetch models (${response.status}): ${body}`);
  }

  const text = await response.text();
  const models = parseCopilotModelsResponse(text);
  console.info(
    `[Copilot Models] Received ${models.length} raw Copilot model(s)` +
      formatModelPreview(models.map((m) => m.id)),
  );
  return models;
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

function parseCopilotModelsResponse(text: string): CopilotModelEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      "[Copilot Models] Failed to parse model catalog JSON:",
      message,
      truncateUpstreamBody(text),
    );
    throw new Error(`Failed to parse models response JSON: ${message}`);
  }

  if (!data || typeof data !== "object" || !("data" in data)) {
    console.warn("[Copilot Models] Model catalog response is missing a data array");
    return [];
  }

  const rawModels = (data as { data?: unknown }).data;
  if (!Array.isArray(rawModels)) {
    console.warn("[Copilot Models] Model catalog data field is not an array:", typeof rawModels);
    return [];
  }

  const models = rawModels.filter(isCopilotModelEntry);
  if (models.length !== rawModels.length) {
    console.warn(
      `[Copilot Models] Ignored ${rawModels.length - models.length} malformed model catalog entrie(s)`,
    );
  }
  return models;
}

function isCopilotModelEntry(value: unknown): value is CopilotModelEntry {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string",
  );
}

function formatModelPreview(modelIds: string[]): string {
  if (modelIds.length === 0) return "";
  const preview = modelIds.slice(0, 8).join(", ");
  const suffix = modelIds.length > 8 ? `, ... +${modelIds.length - 8} more` : "";
  return `: ${preview}${suffix}`;
}
