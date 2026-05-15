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

interface CopilotModelEntry {
  id: string;
  name: string;
  version: string;
  capabilities?: {
    type?: string;
  };
}

/**
 * Fetch available models from the Copilot API and filter for those that
 * Codex CLI can drive.
 *
 * Codex talks the OpenAI Responses wire format and is generally pointed at
 * GPT-class models (gpt-4o, gpt-4.1, gpt-5, the o-series reasoning models,
 * the codex-* / openai-* aliases Copilot exposes). It would be wrong to
 * expose Anthropic models here — Codex would happily POST to
 * `/codex/v1/responses` with a Claude model id, which our converter would
 * forward to ChatCompletions where it would only kind-of-work.
 *
 * We use a straightforward allow-list match against the model id's lower
 * bag of words. If Copilot adds a new GPT-family model the catalog will
 * pick it up automatically; we err on the side of inclusion (a stray
 * unsupported model is recoverable, missing all Codex models breaks the
 * UX completely).
 */
export async function fetchAvailableCodexModels(
  tokenManager: TokenManager,
): Promise<AgentModelInfo[]> {
  const tokenBundle = await resolveTokenBundle(tokenManager);
  const modelsUrl = resolveCopilotModelsUrl(tokenBundle.baseUrl);

  let response = await fetch(modelsUrl, {
    headers: buildHeaders(tokenBundle.token),
  });

  if (!response.ok && modelsUrl !== LEGACY_COPILOT_MODELS_URL && response.status === 404) {
    response = await fetch(LEGACY_COPILOT_MODELS_URL, {
      headers: buildHeaders(tokenBundle.token),
    });
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch models (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { data?: CopilotModelEntry[] };
  const allModels = data.data ?? [];

  return allModels
    .filter((m) => isSupportedCodexModel(m.id))
    .map((m) => ({ id: m.id, name: m.name || m.id }));
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
    "Editor-Version": EDITOR_VERSION,
    "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
    "User-Agent": APP_USER_AGENT,
    "Openai-Organization": "github-copilot",
    "Copilot-Integration-Id": "vscode-chat",
  };
}

async function resolveTokenBundle(
  tokenManager: TokenManager,
): Promise<Pick<CopilotToken, "token" | "baseUrl">> {
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

/**
 * Match GPT-family / Codex-family model ids served by Copilot. Anthropic
 * Claude models, Gemini, and any other non-OpenAI families are filtered
 * out — they don't speak Responses semantics natively, so listing them
 * here would let users mis-target a model that won't behave.
 */
export function isSupportedCodexModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (id.includes("claude")) return false;
  if (id.includes("gemini")) return false;
  if (id.includes("grok")) return false;
  if (id.includes("mistral") || id.includes("ministral")) return false;
  return (
    id.startsWith("gpt-") ||
    id.startsWith("openai/") ||
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.startsWith("o5") ||
    id.includes("codex")
  );
}
