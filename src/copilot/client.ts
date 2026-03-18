import { COPILOT_CHAT_URL } from "../shared/constants";
import { buildCopilotHeaders, buildCopilotStreamHeaders } from "./headers";
import type { CopilotCompletionRequest, CopilotCompletionResponse, CopilotStreamChunk } from "./types";
import { TokenManager } from "./token-manager";

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
}
