import { COPILOT_CHAT_URL } from "../shared/constants";
import {
  buildCopilotHeaders,
  buildCopilotStreamHeaders,
} from "./headers";
import type { CopilotCompletionRequest, CopilotCompletionResponse, CopilotToken } from "./types";
import { TokenManager } from "./token-manager";
import { CopilotUpstreamError, truncateUpstreamBody } from "./upstream-error";

async function resolveChatTarget(
  tokenManager: TokenManager,
): Promise<{ token: string; url: string }> {
  const provider = tokenManager as TokenManager & {
    getTokenBundle?: () => Promise<CopilotToken>;
  };
  if (typeof provider.getTokenBundle === "function") {
    const bundle = await provider.getTokenBundle();
    const base = bundle.baseUrl.trim().replace(/\/+$/, "");
    return {
      token: bundle.token,
      url: base ? `${base}/chat/completions` : COPILOT_CHAT_URL,
    };
  }
  return {
    token: await tokenManager.getToken(),
    url: COPILOT_CHAT_URL,
  };
}

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
    const { token, url } = await resolveChatTarget(this.tokenManager);
    const headers = buildCopilotHeaders(token);

    const response = await fetch(url, {
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
    const { token, url } = await resolveChatTarget(this.tokenManager);
    const headers = buildCopilotStreamHeaders(token);

    const response = await fetch(url, {
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
