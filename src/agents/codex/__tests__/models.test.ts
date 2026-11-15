import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchAvailableCodexModels,
  isSupportedCodexModel,
  prefersResponsesEndpoint,
  resetCodexModelRoutingCache,
} from "../models";
import type { TokenManager } from "../../../copilot/token-manager";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createFetchResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

describe("fetchAvailableCodexModels", () => {
  let tokenManager: TokenManager;

  beforeEach(() => {
    mockFetch.mockReset();
    resetCodexModelRoutingCache();
    tokenManager = {
      getToken: vi.fn().mockResolvedValue("jwt"),
      getTokenBundle: vi.fn().mockResolvedValue({
        token: "jwt",
        expiresAt: Math.floor(Date.now() / 1000) + 1800,
        baseUrl: "https://api.individual.githubcopilot.com",
      }),
    } as unknown as TokenManager;
  });

  it("includes non-GPT chat models (Gemini, Grok, MAI-Code, Claude) while excluding embeddings", async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({
        data: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            version: "gpt-5.5",
            supported_endpoints: ["/responses", "/chat/completions"],
            capabilities: { type: "chat", limits: { max_prompt_tokens: 922000 } },
          },
          {
            id: "gemini-4-hydrogen",
            name: "Gemini 4 Hydrogen",
            version: "gemini-4-hydrogen",
            supported_endpoints: ["/chat/completions"],
            capabilities: { type: "chat", limits: { max_prompt_tokens: 1000000 } },
          },
          {
            id: "grok-4.7",
            name: "Grok 4.7",
            version: "grok-4.7",
            supported_endpoints: ["/chat/completions"],
            capabilities: { type: "chat", limits: { max_prompt_tokens: 128000 } },
          },
          {
            id: "mai-code-2",
            name: "MAI-Code-2.x1",
            version: "mai-code-2",
            supported_endpoints: ["/chat/completions"],
            capabilities: { type: "chat", limits: { max_prompt_tokens: 200000 } },
          },
          {
            id: "gpt-4o",
            name: "GPT-4o",
            version: "gpt-4o-2024-11-20",
            capabilities: { limits: { max_prompt_tokens: 64000 } },
          },
          {
            id: "gpt-4",
            name: "GPT-4",
            version: "gpt-4",
          },
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            version: "claude-sonnet-4-6",
            supported_endpoints: ["/v1/messages", "/chat/completions"],
            capabilities: { type: "chat", limits: { max_prompt_tokens: 200000 } },
          },
          {
            id: "text-embedding-3-small",
            name: "Embedding",
            version: "text-embedding-3-small",
            capabilities: { type: "embeddings" },
          },
        ],
      }),
    );

    const models = await fetchAvailableCodexModels(tokenManager);

    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["gpt-5.5"]?.contextWindow).toBe(922000);
    expect(byId["gpt-4o"]?.contextWindow).toBe(64000);
    expect(byId["gpt-4"]?.contextWindow).toBeUndefined();
    expect(byId["gemini-4-hydrogen"]?.contextWindow).toBe(1000000);
    expect(byId["grok-4.7"]).toBeUndefined();
    expect(byId["mai-code-2"]?.contextWindow).toBe(200000);
    expect(byId["claude-sonnet-4-6"]?.contextWindow).toBe(200000);
    expect(byId["text-embedding-3-small"]).toBeUndefined();

    // Cached supported_endpoints drives endpoint selection
    expect(prefersResponsesEndpoint("gpt-5.5")).toBe(true);
    expect(prefersResponsesEndpoint("gemini-4-hydrogen")).toBe(false);
    expect(prefersResponsesEndpoint("mai-code-2")).toBe(false);
  });
});

describe("isSupportedCodexModel", () => {
  it.each([
    ["gpt-5.5", true],
    ["gpt-4o", true],
    ["gpt-4.1", true],
    ["o3-mini", true],
    ["gpt-5-codex", true],
    ["claude-sonnet-4-6", true],
    ["gemini-4-hydrogen", true],
    ["grok-4.7", false],
    ["mai-code-2", true],
    ["mistral-large", true],
    ["text-embedding-3-large", false],
  ])("%s → %s", (id, expected) => {
    expect(isSupportedCodexModel(id)).toBe(expected);
  });
});
