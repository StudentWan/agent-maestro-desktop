import { COPILOT_CHAT_URL } from "../shared/constants";
import {
  buildCopilotHeaders,
  buildCopilotStreamHeaders,
} from "./headers";
import type { CopilotCompletionRequest, CopilotCompletionResponse } from "./types";
import { TokenManager } from "./token-manager";
import { CopilotUpstreamError, truncateUpstreamBody } from "./upstream-error";

/**
 * HTTP client for the Copilot Chat (`/chat/completions`) API.
 *
 * Agent-agnostic: only knows how to speak the OpenAI ChatCompletions wire
 * format. Anthropic-specific request/response handling lives in
 * `src/agents/claude/anthropic-client.ts`. Codex piggybacks on the methods
 * here through the Codex converter layer.
 */
export class CopilotClient {
  private tokenManager: TokenManager;

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager;
  }

  /** Expose the token manager so per-agent clients (e.g. CopilotAnthropicClient)
   * can be built from the same auth source without re-importing it. */
  getTokenManager(): TokenManager {
    return this.tokenManager;
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
      throw new CopilotUpstreamError(
        `Copilot API error (${response.status})`,
        response.status,
        truncateUpstreamBody(body),
      );
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
      throw new CopilotUpstreamError(
        `Copilot API stream error (${response.status})`,
        response.status,
        truncateUpstreamBody(body),
      );
    }

    return response;
  }
}
