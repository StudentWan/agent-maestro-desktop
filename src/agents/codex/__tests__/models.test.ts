import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchAvailableCodexModels, isSupportedCodexModel } from "../models";
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
    tokenManager = {
      getToken: vi.fn().mockResolvedValue("jwt"),
      getTokenBundle: vi.fn().mockResolvedValue({
        token: "jwt",
        expiresAt: Math.floor(Date.now() / 1000) + 1800,
        baseUrl: "https://api.individual.githubcopilot.com",
      }),
    } as unknown as TokenManager;
  });

  it("maps capabilities.limits.max_prompt_tokens into contextWindow on each returned model", async () => {
    // Shape mirrors what Copilot's /models endpoint actually returns —
    // verified by direct call in the planning notes.
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({
        data: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            version: "gpt-5.5",
            capabilities: { limits: { max_prompt_tokens: 922000 } },
          },
          {
            id: "gpt-4o",
            name: "GPT-4o",
            version: "gpt-4o-2024-11-20",
            capabilities: { limits: { max_prompt_tokens: 64000 } },
          },
          {
            // Older entry without limits — must still appear, contextWindow undefined.
            id: "gpt-4",
            name: "GPT-4",
            version: "gpt-4",
          },
          {
            // Non-Codex model — filtered out.
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            version: "claude-sonnet-4-6",
            capabilities: { limits: { max_prompt_tokens: 200000 } },
          },
        ],
      }),
    );

    const models = await fetchAvailableCodexModels(tokenManager);

    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["gpt-5.5"]?.contextWindow).toBe(922000);
    expect(byId["gpt-4o"]?.contextWindow).toBe(64000);
    // No limits field → undefined, NOT 0 / null.
    expect(byId["gpt-4"]?.contextWindow).toBeUndefined();
    // Claude filtered out by isSupportedCodexModel.
    expect(byId["claude-sonnet-4-6"]).toBeUndefined();
  });
});

describe("isSupportedCodexModel", () => {
  it.each([
    ["gpt-5.5", true],
    ["gpt-4o", true],
    ["gpt-4.1", true],
    ["o3-mini", true],
    ["gpt-5-codex", true],
    ["claude-sonnet-4-6", false],
    ["gemini-2.5", false],
    ["grok-4", false],
    ["mistral-large", false],
  ])("%s → %s", (id, expected) => {
    expect(isSupportedCodexModel(id)).toBe(expected);
  });
});
