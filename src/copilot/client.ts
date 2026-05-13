import { COPILOT_CHAT_URL } from "../shared/constants";
import {
  buildCopilotAnthropicHeaders,
  buildCopilotHeaders,
  buildCopilotStreamHeaders,
  hasContext1mBeta,
  type CopilotAnthropicHeaderOptions,
} from "./headers";
import { applyCopilotPromptCache } from "./prompt-cache";
import type { CopilotCompletionRequest, CopilotCompletionResponse, CopilotStreamChunk } from "./types";
import { TokenManager } from "./token-manager";
import type { AnthropicRequest, AnthropicResponse } from "../converter/types";
import { mapModelName } from "../converter/model-mapper";

function resolveAnthropicMessagesUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function resolveCopilotClaudeModel(model: string, options: CopilotAnthropicHeaderOptions): string {
  const resolvedModel =
    hasContext1mBeta(options.anthropicBeta) && !isOneMillionContextModel(model)
      ? `${model}-1m`
      : model;
  return mapModelName(resolvedModel);
}

function isOneMillionContextModel(model: string): boolean {
  return /(?:^|-)1m(?:-|$)/.test(model);
}

function prepareCopilotAnthropicRequest(
  request: AnthropicRequest,
  options: CopilotAnthropicHeaderOptions,
  stream: boolean,
): AnthropicRequest {
  const compatibleRequest = stripUnsupportedCopilotTools({
    ...request,
    model: resolveCopilotClaudeModel(request.model, options),
    stream,
  });
  return normalizeReasoningForCopilot(adaptThinkingForCopilot(applyCopilotPromptCache(compatibleRequest)));
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
      effort: request.output_config?.effort ?? resolveThinkingEffort(budgetTokens),
    },
  };
}

function normalizeReasoningForCopilot(request: AnthropicRequest): AnthropicRequest {
  if (supportsCopilotReasoning(request.model)) {
    return request;
  }

  if (!request.thinking && !request.output_config?.effort) {
    return request;
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

function supportsCopilotReasoning(model: string): boolean {
  return /claude-(?:opus|sonnet)/i.test(model);
}

function resolveThinkingEffort(budgetTokens: number | undefined): "low" | "medium" | "high" {
  if (budgetTokens === undefined || !Number.isFinite(budgetTokens)) {
    return "medium";
  }
  if (budgetTokens >= 16_000) {
    return "high";
  }
  if (budgetTokens >= 4_000) {
    return "medium";
  }
  return "low";
}

/**
 * HTTP client for the Copilot Chat API
 */
export class CopilotClient {
  private tokenManager: TokenManager;

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager;
  }

  /**
   * Send a non-streaming chat completion request
   */
  async chatCompletion(request: CopilotCompletionRequest): Promise<CopilotCompletionResponse> {
    const token = await this.tokenManager.getToken();
    const headers = buildCopilotHeaders(token);

    const response = await fetch(COPILOT_CHAT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request, stream: false }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Copilot API error (${response.status}): ${body}`);
    }

    return response.json() as Promise<CopilotCompletionResponse>;
  }

  /**
   * Send a streaming chat completion request, returns a ReadableStream
   */
  async chatCompletionStream(request: CopilotCompletionRequest): Promise<Response> {
    const token = await this.tokenManager.getToken();
    const headers = buildCopilotStreamHeaders(token);

    const response = await fetch(COPILOT_CHAT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request, stream: true }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Copilot API stream error (${response.status}): ${body}`);
    }

    return response;
  }

  /**
   * Send a Claude Anthropic Messages request through the Copilot Anthropic endpoint.
   */
  async anthropicMessages(
    request: AnthropicRequest,
    options: CopilotAnthropicHeaderOptions = {},
  ): Promise<AnthropicResponse> {
    const tokenBundle = await this.tokenManager.getTokenBundle();
    const headers = buildCopilotAnthropicHeaders(tokenBundle.token, request, options);
    const body = prepareCopilotAnthropicRequest(request, options, false);

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
  async anthropicMessagesStream(
    request: AnthropicRequest,
    options: CopilotAnthropicHeaderOptions = {},
  ): Promise<Response> {
    const tokenBundle = await this.tokenManager.getTokenBundle();
    const headers = buildCopilotAnthropicHeaders(tokenBundle.token, request, options);
    const body = prepareCopilotAnthropicRequest(request, options, true);

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
}
