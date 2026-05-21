import { describe, it, expect, vi, beforeEach } from "vitest";
import { CopilotResponsesClient } from "../responses-client";
import { TokenManager } from "../../../copilot/token-manager";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createFetchResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    body: null,
  };
}

describe("CopilotResponsesClient", () => {
  let client: CopilotResponsesClient;
  let tokenManager: TokenManager;

  beforeEach(() => {
    mockFetch.mockReset();
    tokenManager = {
      getToken: vi.fn().mockResolvedValue("jwt-copilot-token"),
      getTokenBundle: vi.fn().mockResolvedValue({
        token: "jwt-copilot-token",
        expiresAt: Math.floor(Date.now() / 1000) + 1800,
        baseUrl: "https://api.individual.githubcopilot.com",
      }),
    } as unknown as TokenManager;
    client = new CopilotResponsesClient(tokenManager);
  });

  it("POSTs the body verbatim to ${baseUrl}/responses (no ChatCompletions translation)", async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ id: "resp_1", object: "response" }),
    );

    await client.createResponse({
      model: "gpt-5.5",
      input: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", name: "foo", parameters: {} }],
      reasoning: { effort: "high" },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.individual.githubcopilot.com/responses");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer jwt-copilot-token",
        "Copilot-Integration-Id": "vscode-chat",
      }),
    );
    const body = JSON.parse(init.body);
    // Body shape preserved exactly — no flattening to messages[].
    expect(body.model).toBe("gpt-5.5");
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
    expect(body.tools).toEqual([
      { type: "function", name: "foo", parameters: {} },
    ]);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.stream).toBe(false);
  });

  it("forces stream=true on the streaming variant and asks for SSE", async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ id: "resp_1", object: "response" }),
    );

    await client.createResponseStream({
      model: "gpt-5.5",
      input: "hi",
      stream: false, // caller's stream flag is overridden
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(init.headers).toEqual(
      expect.objectContaining({ Accept: "text/event-stream" }),
    );
  });

  it("strips previous_response_id / conversation as a defence in depth", async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ id: "resp_1", object: "response" }),
    );

    await client.createResponse({
      model: "gpt-5.5",
      input: "hi",
      previous_response_id: "resp_old",
      conversation: { id: "conv_old" },
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body).not.toHaveProperty("conversation");
    // Other fields preserved.
    expect(body.model).toBe("gpt-5.5");
    expect(body.input).toBe("hi");
  });

  it("surfaces upstream errors with status + body in the thrown message", async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse(
        { error: { message: "model not found" } },
        false,
        404,
      ),
    );
    await expect(
      client.createResponse({ model: "nope", input: "hi" }),
    ).rejects.toThrow(/Copilot Responses API error \(404\)/);
  });
});
