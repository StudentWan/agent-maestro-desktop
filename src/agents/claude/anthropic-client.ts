/**
 * Claude-specific client extension.
 *
 * Encapsulates everything that's Anthropic-Messages-API-shaped:
 *   - request body adapters (1M-context model rewrite, prompt cache,
 *     thinking/effort normalisation, web_search tool stripping)
 *   - the actual fetch to Copilot's `/v1/messages` endpoint
 *
 * The generic `CopilotClient` (src/copilot/client.ts) stays free of any
 * Anthropic vocabulary so other agents (Codex) can reuse it without
 * pulling Claude code in.
 */
import { TokenManager } from "../../copilot/token-manager";
import {
  buildCopilotAnthropicHeaders,
  hasContext1mBeta,
  type CopilotAnthropicHeaderOptions,
} from "./anthropic-headers";
import { applyCopilotPromptCache } from "./prompt-cache";
import { mapModelName } from "./converter/model-mapper";
import { fetchCopilotModelEntries } from "./models";
import type { CopilotToken } from "../../copilot/types";
import type {
  AnthropicOutputConfig,
  AnthropicRequest,
  AnthropicResponse,
} from "./converter/types";

type ReasoningEffort = NonNullable<AnthropicOutputConfig["effort"]>;

const REASONING_EFFORT_ORDER: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const REASONING_EFFORT_CATALOG_TTL_MS = 5 * 60 * 1000;
const REASONING_EFFORT_FAILURE_TTL_MS = 60 * 1000;

interface ReasoningEffortCatalog {
  baseUrl: string;
  expiresAt: number;
  effortsByModel: Map<string, ReasoningEffort[]>;
}

function resolveAnthropicMessagesUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function resolveCopilotClaudeModel(model: string, options: CopilotAnthropicHeaderOptions): string {
  const mappedModel = mapModelName(model);
  if (!hasContext1mBeta(options.anthropicBeta) || isOneMillionContextModel(mappedModel)) {
    return mappedModel;
  }
  return resolveOneMillionContextModel(mappedModel);
}

function isOneMillionContextModel(model: string): boolean {
  return /(?:^|-)1m(?:-|$)/.test(model);
}

function resolveOneMillionContextModel(model: string): string {
  switch (model.toLowerCase()) {
    case "claude-opus-4.6":
      return "claude-opus-4.6-1m";
    case "claude-opus-4.7":
      return "claude-opus-4.7-1m-internal";
    default:
      return model;
  }
}

function prepareCopilotAnthropicRequest(
  request: AnthropicRequest,
  options: CopilotAnthropicHeaderOptions,
  stream: boolean,
  supportedReasoningEfforts?: ReasoningEffort[],
  resolvedModel = resolveCopilotClaudeModel(request.model, options),
): AnthropicRequest {
  const compatibleRequest = stripUnsupportedCopilotTools({
    ...request,
    model: resolvedModel,
    stream,
  });
  const prepared = normalizeReasoningForCopilot(
    adaptThinkingForCopilot(applyCopilotPromptCache(compatibleRequest)),
    supportedReasoningEfforts,
  );
  // Copilot never accepts context_management — strip unconditionally.
  if ("context_management" in prepared) {
    const { context_management: _, ...rest } = prepared;
    return rest as AnthropicRequest;
  }
  return prepared;
}

function stripUnsupportedCopilotTools(request: AnthropicRequest): AnthropicRequest {
  if (!request.tools?.some(isUnsupportedCopilotTool)) {
    return request;
  }

  const tools = request.tools.filter((tool) => !isUnsupportedCopilotTool(tool));
  const nextRequest: AnthropicRequest = { ...request };
  if (tools.length > 0) {
    nextRequest.tools = tools;
  } else {
    delete nextRequest.tools;
    delete nextRequest.tool_choice;
  }

  if (nextRequest.tool_choice && isUnsupportedToolChoice(nextRequest.tool_choice)) {
    delete nextRequest.tool_choice;
  }

  return nextRequest;
}

function isUnsupportedCopilotTool(tool: { name?: unknown; type?: unknown }): boolean {
  return isAnthropicWebSearchIdentifier(tool.name) || isAnthropicWebSearchIdentifier(tool.type);
}

function isUnsupportedToolChoice(toolChoice: { name?: unknown; type?: unknown }): boolean {
  return isAnthropicWebSearchIdentifier(toolChoice.name) || isAnthropicWebSearchIdentifier(toolChoice.type);
}

function isAnthropicWebSearchIdentifier(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.toLowerCase();
  return normalized === "web_search" || normalized.startsWith("web_search_");
}

function adaptThinkingForCopilot(request: AnthropicRequest): AnthropicRequest {
  if (request.thinking?.type !== "enabled") {
    return request;
  }

  const { budget_tokens: budgetTokens, ...thinking } = request.thinking;
  return {
    ...request,
    thinking: { ...thinking, type: "adaptive" },
    output_config: {
      ...request.output_config,
      effort: request.output_config?.effort ?? resolveThinkingEffort(request.model, budgetTokens),
    },
  };
}

function normalizeReasoningForCopilot(
  request: AnthropicRequest,
  supportedReasoningEfforts?: ReasoningEffort[],
): AnthropicRequest {
  if (!request.thinking && !request.output_config?.effort) {
    return request;
  }

  const effort = resolveCopilotReasoningEffort(
    request.model,
    request.output_config?.effort,
    supportedReasoningEfforts,
  );
  if (effort) {
    return {
      ...request,
      output_config: {
        ...request.output_config,
        effort,
      },
    };
  }

  const { effort: _effort, ...outputConfig } = request.output_config ?? {};
  const nextRequest: AnthropicRequest = { ...request };
  delete nextRequest.thinking;
  delete nextRequest.context_management;

  if (Object.keys(outputConfig).length > 0) {
    nextRequest.output_config = outputConfig;
  } else {
    delete nextRequest.output_config;
  }

  return nextRequest;
}

function resolveCopilotReasoningEffort(
  model: string,
  requestedEffort: AnthropicOutputConfig["effort"],
  supportedReasoningEfforts?: ReasoningEffort[],
): AnthropicOutputConfig["effort"] | undefined {
  if (supportedReasoningEfforts) {
    return chooseSupportedReasoningEffort(requestedEffort, supportedReasoningEfforts);
  }

  const normalized = model.toLowerCase();
  if (normalized.includes("haiku") || normalized.includes("sonnet-4.5") || normalized.includes("opus-4.5")) {
    return undefined;
  }
  if (normalized.includes("opus-4.7-xhigh")) {
    return "xhigh";
  }
  if (normalized.includes("opus-4.7-high")) {
    return "high";
  }
  if (normalized === "claude-opus-4.7") {
    return "medium";
  }
  return requestedEffort;
}

function chooseSupportedReasoningEffort(
  requestedEffort: AnthropicOutputConfig["effort"],
  supportedReasoningEfforts: ReasoningEffort[],
): ReasoningEffort | undefined {
  if (supportedReasoningEfforts.length === 0) {
    return undefined;
  }

  const requested = requestedEffort ?? "medium";
  if (supportedReasoningEfforts.includes(requested)) {
    return requested;
  }

  const requestedRank = REASONING_EFFORT_ORDER.indexOf(requested);
  const targetRank = requestedRank >= 0 ? requestedRank : REASONING_EFFORT_ORDER.indexOf("medium");
  let bestEffort = supportedReasoningEfforts[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestRank = -1;

  for (const effort of supportedReasoningEfforts) {
    const rank = REASONING_EFFORT_ORDER.indexOf(effort);
    if (rank < 0) {
      continue;
    }
    const distance = Math.abs(rank - targetRank);
    if (distance < bestDistance || (distance === bestDistance && rank > bestRank)) {
      bestEffort = effort;
      bestDistance = distance;
      bestRank = rank;
    }
  }

  return bestEffort;
}

function normalizeSupportedReasoningEfforts(efforts: string[] | undefined): ReasoningEffort[] {
  if (!efforts) {
    return [];
  }
  return efforts.filter((effort): effort is ReasoningEffort =>
    REASONING_EFFORT_ORDER.includes(effort as ReasoningEffort),
  );
}

function needsReasoningNormalization(request: AnthropicRequest): boolean {
  return Boolean(request.thinking || request.output_config?.effort);
}

function resolveThinkingEffort(
  model: string,
  budgetTokens: number | undefined,
): AnthropicOutputConfig["effort"] {
  if (budgetTokens === undefined || !Number.isFinite(budgetTokens)) {
    return "medium";
  }
  if (supportsXHighThinkingBudget(model) && budgetTokens >= 30_000) {
    return "xhigh";
  }
  if (budgetTokens >= 16_000) {
    return "high";
  }
  if (budgetTokens >= 4_000) {
    return "medium";
  }
  return "low";
}

function supportsXHighThinkingBudget(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("opus-4.7-1m") || normalized.includes("opus-4.7-xhigh");
}

/**
 * HTTP client for the Copilot Anthropic Messages endpoint.
 * Mirrors the surface of CopilotClient.anthropicMessages* — but lives in
 * the Claude plugin so the generic Copilot client stays Anthropic-free.
 */
export class CopilotAnthropicClient {
  private reasoningEffortCatalog: ReasoningEffortCatalog | null = null;
  private reasoningEffortCatalogPromise: { baseUrl: string; promise: Promise<ReasoningEffortCatalog> } | null = null;
  private reasoningEffortCatalogFailureExpiresAt = 0;

  constructor(private readonly tokenManager: TokenManager) {}

  /**
   * Send a Claude Anthropic Messages request through the Copilot Anthropic endpoint.
   */
  async messages(
    request: AnthropicRequest,
    options: CopilotAnthropicHeaderOptions = {},
  ): Promise<AnthropicResponse> {
    const tokenBundle = await this.tokenManager.getTokenBundle();
    const headers = buildCopilotAnthropicHeaders(tokenBundle.token, request, options);
    const resolvedModel = resolveCopilotClaudeModel(request.model, options);
    const supportedReasoningEfforts = needsReasoningNormalization(request)
      ? await this.getSupportedReasoningEfforts(tokenBundle, resolvedModel)
      : undefined;
    const body = prepareCopilotAnthropicRequest(request, options, false, supportedReasoningEfforts, resolvedModel);

    const response = await fetch(resolveAnthropicMessagesUrl(tokenBundle.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`Copilot Anthropic Messages error (${response.status}): ${bodyText}`);
    }

    const json = await response.json() as AnthropicResponse;
    return { ...json, model: request.model };
  }

  /**
   * Send a streaming Claude Anthropic Messages request through Copilot.
   */
  async messagesStream(
    request: AnthropicRequest,
    options: CopilotAnthropicHeaderOptions = {},
  ): Promise<Response> {
    const tokenBundle = await this.tokenManager.getTokenBundle();
    const headers = buildCopilotAnthropicHeaders(tokenBundle.token, request, options);
    const resolvedModel = resolveCopilotClaudeModel(request.model, options);
    const supportedReasoningEfforts = needsReasoningNormalization(request)
      ? await this.getSupportedReasoningEfforts(tokenBundle, resolvedModel)
      : undefined;
    const body = prepareCopilotAnthropicRequest(request, options, true, supportedReasoningEfforts, resolvedModel);

    const response = await fetch(resolveAnthropicMessagesUrl(tokenBundle.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`Copilot Anthropic Messages stream error (${response.status}): ${bodyText}`);
    }

    return response;
  }

  private async getSupportedReasoningEfforts(
    tokenBundle: Pick<CopilotToken, "token" | "baseUrl">,
    model: string,
  ): Promise<ReasoningEffort[] | undefined> {
    if (Date.now() < this.reasoningEffortCatalogFailureExpiresAt) {
      return undefined;
    }

    try {
      const catalog = await this.getReasoningEffortCatalog(tokenBundle);
      return catalog.effortsByModel.get(model.toLowerCase());
    } catch (error) {
      this.reasoningEffortCatalogFailureExpiresAt = Date.now() + REASONING_EFFORT_FAILURE_TTL_MS;
      console.warn("[CopilotAnthropicClient] Failed to fetch Copilot model capabilities:", error);
      return undefined;
    }
  }

  private async getReasoningEffortCatalog(
    tokenBundle: Pick<CopilotToken, "token" | "baseUrl">,
  ): Promise<ReasoningEffortCatalog> {
    const baseUrl = tokenBundle.baseUrl.trim().replace(/\/+$/, "");
    const now = Date.now();

    if (
      this.reasoningEffortCatalog &&
      this.reasoningEffortCatalog.baseUrl === baseUrl &&
      this.reasoningEffortCatalog.expiresAt > now
    ) {
      return this.reasoningEffortCatalog;
    }

    if (this.reasoningEffortCatalogPromise?.baseUrl === baseUrl) {
      return this.reasoningEffortCatalogPromise.promise;
    }

    const promise = fetchCopilotModelEntries(tokenBundle).then((entries) => {
      const effortsByModel = new Map<string, ReasoningEffort[]>();
      for (const entry of entries) {
        effortsByModel.set(
          entry.id.toLowerCase(),
          normalizeSupportedReasoningEfforts(entry.capabilities?.supports?.reasoning_effort),
        );
      }
      const catalog: ReasoningEffortCatalog = {
        baseUrl,
        expiresAt: Date.now() + REASONING_EFFORT_CATALOG_TTL_MS,
        effortsByModel,
      };
      this.reasoningEffortCatalog = catalog;
      return catalog;
    });

    this.reasoningEffortCatalogPromise = { baseUrl, promise };
    try {
      return await promise;
    } finally {
      if (this.reasoningEffortCatalogPromise?.promise === promise) {
        this.reasoningEffortCatalogPromise = null;
      }
    }
  }
}
