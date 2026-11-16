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

interface CopilotModelEntry {
  id: string;
  name: string;
  version: string;
  supported_endpoints?: string[];
  capabilities?: {
    type?: string;
    supports?: {
      reasoning_effort?: string[];
    };
    limits?: {
      /**
       * Max prompt tokens the model accepts. Read by the Codex local/
       * remote config writers and stamped into `model_context_window` so
       * the CLI compacts before bodies exceed Copilot's 413 ceiling.
       * Field name mirrors what Copilot's `/models` endpoint returns.
       */
      max_prompt_tokens?: number;
    };
  };
}

/**
 * Cache of modelId (lowercased) -> supported endpoints reported by Copilot's
 * `/models` catalog, plus runtime overrides when `/responses` rejects a model
 * with `unsupported_api_for_model`.
 */
const modelEndpointsCache = new Map<string, string[]>();
const modelReasoningEffortsCache = new Map<string, string[]>();
const chatCompletionsOnlyOverrides = new Set<string>();

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

  console.info(`[Codex Models] Fetching model catalog: ${modelsUrl}`);
  let response = await fetch(modelsUrl, {
    headers: buildHeaders(tokenBundle.token),
  });
  console.info(`[Codex Models] ${modelsUrl} responded with HTTP ${response.status}`);

  if (!response.ok && modelsUrl !== LEGACY_COPILOT_MODELS_URL && response.status === 404) {
    console.warn(
      `[Codex Models] ${modelsUrl} returned 404; retrying legacy endpoint ${LEGACY_COPILOT_MODELS_URL}`,
    );
    response = await fetch(LEGACY_COPILOT_MODELS_URL, {
      headers: buildHeaders(tokenBundle.token),
    });
    console.info(`[Codex Models] ${LEGACY_COPILOT_MODELS_URL} responded with HTTP ${response.status}`);
  }

  if (!response.ok) {
    const body = await response.text();
    console.error(`[Codex Models] Failed to fetch model catalog (${response.status}):`, body);
    throw new Error(`Failed to fetch models (${response.status}): ${body}`);
  }

  const text = await response.text();
  const allModels = parseCopilotModelsResponse(text);

  console.info(
    `[Codex Models] Received ${allModels.length} raw Copilot model(s)` +
      formatModelPreview(allModels.map((m) => m.id)),
  );

  const codexModels = allModels
    .filter((m) => isSupportedCodexModel(m))
    .map((m) => {
      if (Array.isArray(m.supported_endpoints) && m.supported_endpoints.length > 0) {
        modelEndpointsCache.set(m.id.toLowerCase(), m.supported_endpoints);
      }
      const reasoningEfforts = Array.isArray(m.capabilities?.supports?.reasoning_effort)
        ? m.capabilities.supports.reasoning_effort
        : undefined;
      if (reasoningEfforts && reasoningEfforts.length > 0) {
        modelReasoningEffortsCache.set(m.id.toLowerCase(), reasoningEfforts);
      }
      return {
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.capabilities?.limits?.max_prompt_tokens,
        reasoningEfforts,
      };
    });

  console.info(
    `[Codex Models] Filtered ${codexModels.length} Codex model(s) from ${allModels.length} Copilot model(s)` +
      formatModelPreview(codexModels.map((m) => m.id)),
  );

  return codexModels;
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
 * Determine whether a Copilot model can be driven by Codex CLI / Codex App.
 *
 * We include all chat/completion models (GPT, o-series, Codex, Gemini, Grok,
 * MAI-Code, Claude, etc.) and exclude non-chat models such as embeddings.
 * Models that don't speak Copilot's native `/responses` endpoint are routed
 * through the Responses <-> ChatCompletions converter in `routes/responses.ts`.
 */
export function isSupportedCodexModel(modelOrId: string | CopilotModelEntry): boolean {
  const id = (typeof modelOrId === "string" ? modelOrId : modelOrId.id).toLowerCase();
  if (!id || id.includes("embedding")) return false;
  // Grok's Copilot /responses backend rejects Codex App's tool/namespace payloads
  // and is not accessible via /chat/completions, so exclude it from Codex.
  if (id.includes("grok")) return false;

  if (typeof modelOrId !== "string") {
    const capType = modelOrId.capabilities?.type?.toLowerCase();
    if (capType && capType !== "chat") return false;

    const endpoints = modelOrId.supported_endpoints;
    if (Array.isArray(endpoints) && endpoints.length > 0) {
      return endpoints.includes("/responses") || endpoints.includes("/chat/completions");
    }
  }

  return true;
}

/**
 * Decide whether a model should be forwarded to Copilot's native `/responses`
 * endpoint or translated to `/chat/completions`.
 */
export function prefersResponsesEndpoint(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (chatCompletionsOnlyOverrides.has(id)) {
    return false;
  }

  const cached = modelEndpointsCache.get(id);
  if (cached && cached.length > 0) {
    if (cached.includes("/responses")) return true;
    if (cached.includes("/chat/completions")) return false;
  }

  // Heuristic fallback when `/models` hasn't been fetched yet or omitted
  // `supported_endpoints`: OpenAI Responses-native families go to `/responses`;
  // other families (Gemini, Grok, Claude, MAI-Code, Mistral, etc.) go straight
  // to `/chat/completions` via the converter.
  return (
    id.startsWith("gpt-5") ||
    id.startsWith("gpt-6") ||
    id.startsWith("openai/") ||
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.startsWith("o5") ||
    id.includes("codex")
  );
}

const REASONING_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function getSupportedReasoningEfforts(modelId: string): string[] | undefined {
  return modelReasoningEffortsCache.get(modelId.toLowerCase());
}

export function resolveCodexReasoningEffort(
  modelId: string,
  requestedEffort: string | undefined,
): string | undefined {
  if (!requestedEffort) return undefined;
  const supported = modelReasoningEffortsCache.get(modelId.toLowerCase());
  if (!supported || supported.length === 0) {
    return undefined;
  }
  const normalized = requestedEffort.toLowerCase();
  if (supported.includes(normalized)) {
    return normalized;
  }

  const targetRank = REASONING_EFFORT_ORDER.indexOf(
    normalized as (typeof REASONING_EFFORT_ORDER)[number],
  );
  if (targetRank < 0) return supported[0];

  let best = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const rank = REASONING_EFFORT_ORDER.indexOf(
      candidate as (typeof REASONING_EFFORT_ORDER)[number],
    );
    if (rank < 0) continue;
    const distance = Math.abs(rank - targetRank);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Record at runtime that a model was rejected by `/responses` as
 * unsupported so subsequent requests go directly to `/chat/completions`.
 */
export function markModelRequiresChatCompletions(modelId: string): void {
  chatCompletionsOnlyOverrides.add(modelId.toLowerCase());
}

/** Test-only helper to clear cached endpoint metadata between test cases. */
export function resetCodexModelRoutingCache(): void {
  modelEndpointsCache.clear();
  modelReasoningEffortsCache.clear();
  chatCompletionsOnlyOverrides.clear();
}

function parseCopilotModelsResponse(text: string): CopilotModelEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      "[Codex Models] Failed to parse model catalog JSON:",
      message,
      truncateUpstreamBody(text),
    );
    throw new Error(`Failed to parse models response JSON: ${message}`);
  }

  if (!data || typeof data !== "object" || !("data" in data)) {
    console.warn("[Codex Models] Model catalog response is missing a data array");
    return [];
  }

  const rawModels = (data as { data?: unknown }).data;
  if (!Array.isArray(rawModels)) {
    console.warn("[Codex Models] Model catalog data field is not an array:", typeof rawModels);
    return [];
  }

  const models = rawModels.filter(isCopilotModelEntry);
  if (models.length !== rawModels.length) {
    console.warn(
      `[Codex Models] Ignored ${rawModels.length - models.length} malformed model catalog entrie(s)`,
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
