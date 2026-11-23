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

  it("strips OpenAI-only metadata Copilot ignores (store/include/prompt_cache_key/etc.) to dodge 413 on long sessions", async () => {
    mockFetch.mockResolvedValueOnce(
      createFetchResponse({ id: "resp_1", object: "response" }),
    );

    await client.createResponse({
      model: "gpt-5.5",
      input: "hi",
      // Fields Copilot doesn't honor; we strip to shrink the body.
      store: true,
      include: ["reasoning.encrypted_content"],
      background: false,
      prompt: { id: "tpl_x", variables: {} },
      prompt_cache_key: "cache-key-1",
      service_tier: "auto",
      user: "user-1",
      safety_identifier: "safety-1",
      metadata: { foo: "bar" },
      // Things we MUST keep:
      tools: [{ type: "function", name: "f", parameters: {} }],
      reasoning: { effort: "high" },
      instructions: "Be concise.",
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    for (const k of [
      "store",
      "include",
      "background",
      "prompt",
      "prompt_cache_key",
      "service_tier",
      "user",
      "safety_identifier",
      "metadata",
    ]) {
      expect(body, `field "${k}" should be stripped`).not.toHaveProperty(k);
    }
    // Kept fields still there.
    expect(body.model).toBe("gpt-5.5");
    expect(body.tools).toHaveLength(1);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.instructions).toBe("Be concise.");
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

  it("drops tool_search and flattens namespace tools for non-OpenAI models like gemini-4-hydrogen", async () => {
    mockFetch.mockResolvedValueOnce(createFetchResponse({ id: "resp_gemini" }));

    await client.createResponse({
      model: "gemini-4-hydrogen",
      input: "hi",
      client_metadata: { x: "1" },
      tools: [
        { type: "function", name: "shell" },
        { type: "tool_search" },
        {
          type: "namespace",
          name: "mcp",
          tools: [{ type: "function", name: "mcp__read" }],
        },
      ],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("client_metadata");
    expect(body.tools).toEqual([
      { type: "function", name: "shell" },
      { type: "function", name: "mcp__read" },
    ]);
  });

  describe.each(["createResponse", "createResponseStream"] as const)(
    "%s account history recovery",
    (method) => {
      const ownershipMessage = "input item does not belong to this connection";
      const successBody = { id: "resp_recovered", object: "response", output: [] };
      const isStream = method === "createResponseStream";

      it.each([
        [400, "input item does not belong to this connection"],
        [401, "input item does not belong to this connection"],
        [400, "input item ID does not belong to this connection"],
        [401, "input item ID does not belong to this connection"],
      ])("recovers once from HTTP %i with exact error %s", async (status, message) => {
        const success = createFetchResponse(successBody);
        mockFetch
          .mockResolvedValueOnce(createFetchResponse({ error: { message } }, false, status))
          .mockResolvedValueOnce(success);
        const request = {
          model: "gpt-6-astra",
          input: [{ type: "message", id: "msg_account_a", role: "assistant", content: "Earlier answer" }],
        };

        const result = await client[method](request);

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ ...request, stream: isStream });
        expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
          model: "gpt-6-astra",
          input: [{ type: "message", role: "assistant", content: "Earlier answer" }],
          stream: isStream,
        });
        if (isStream) expect(result).toBe(success);
        else expect(result).toEqual(successBody);
        for (const [url, init] of mockFetch.mock.calls) {
          expect(url).toBe("https://api.individual.githubcopilot.com/responses");
          expect(init.headers).toEqual(expect.objectContaining({
            Authorization: "Bearer jwt-copilot-token",
            Accept: isStream ? "text/event-stream" : "application/json",
          }));
        }
      });

      it("preserves complete visible history, tool links, images and options without mutating the request", async () => {
        const user = {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Continue the work", metadata: { id: "business_record" } },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "high" },
          ],
        };
        const assistant = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking both files." }] };
        const callA = { type: "function_call", call_id: "call_a", name: "read_file", arguments: '{"id":"record_a","path":"a.txt"}' };
        const callB = { type: "function_call", call_id: "call_b", name: "read_file", arguments: '{"id":"record_b","path":"b.txt"}' };
        const outputA = { type: "function_call_output", call_id: "call_a", output: '{"id":"record_a","text":"A"}' };
        const outputB = { type: "function_call_output", call_id: "call_b", output: [{ type: "input_text", text: "B", id: "nested_output_id" }] };
        const request = {
          model: "gpt-6-astra",
          instructions: "Keep the user's existing decisions.",
          reasoning: { effort: "high", summary: "auto" },
          tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: { id: { type: "string" } } } }],
          parallel_tool_calls: true,
          tool_choice: "auto",
          input: [
            { ...user, id: "msg_user_old" },
            { type: "reasoning", id: "rs_a", encrypted_content: "old_reasoning_cipher", summary: [] },
            { ...assistant, id: "msg_assistant_old" },
            { ...callA, id: "fc_a" },
            { ...callB, id: "fc_b" },
            { ...outputA, id: "fco_a" },
            { ...outputB, id: "fco_b" },
            { type: "reasoning", summary: [{ type: "summary_text", text: "Prior summary" }] },
          ],
        };
        const original = structuredClone(request);
        mockFetch
          .mockResolvedValueOnce(createFetchResponse({ error: { message: ownershipMessage } }, false, 401))
          .mockResolvedValueOnce(createFetchResponse(successBody));

        await client[method](request);

        expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ ...original, stream: isStream });
        expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
          ...original,
          input: [user, assistant, callA, callB, outputA, outputB],
          stream: isStream,
        });
        expect(request).toEqual(original);
      });

      it("keeps reference IDs, encrypted compaction and other opaque history content", async () => {
        const reference = { type: "item_reference", id: "item_required_reference" };
        const compaction = { type: "compaction", encrypted_content: "essential_compaction", summary: "Context" };
        const alias = { type: "compaction_summary", encrypted_content: "essential_compaction_alias" };
        const opaque = { type: "future_history_item", id: "opaque_required_id", encrypted_content: "unknown_but_essential", payload: { id: "nested_id" } };
        const request = {
          model: "gpt-6-astra",
          input: [
            reference,
            { ...compaction, id: "cmp_old" },
            { ...alias, id: "cmp_alias_old" },
            opaque,
            { type: "reasoning", id: "rs_old", encrypted_content: "removable_reasoning" },
          ],
        };
        const original = structuredClone(request);
        mockFetch
          .mockResolvedValueOnce(createFetchResponse({ error: { message: ownershipMessage } }, false, 400))
          .mockResolvedValueOnce(createFetchResponse(successBody));

        await client[method](request);

        expect(JSON.parse(mockFetch.mock.calls[1][1].body).input).toEqual([
          reference, compaction, alias, opaque,
        ]);
        expect(request).toEqual(original);
      });

      it("preserves implicit references and MCP approval links while replaying custom tool calls", async () => {
        const implicitReference = { id: "reference_without_type" };
        const approvalRequest = {
          type: "mcp_approval_request",
          id: "approval_a",
          name: "read_document",
          server_label: "documents",
          arguments: '{"id":"document_a"}',
        };
        const approvalResponse = {
          type: "mcp_approval_response",
          id: "approval_response_a",
          approval_request_id: "approval_a",
          approve: true,
        };
        const customCall = {
          type: "custom_tool_call",
          call_id: "custom_call_a",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
        };
        const customOutput = {
          type: "custom_tool_call_output",
          call_id: "custom_call_a",
          output: "Patch applied successfully",
        };
        const untypedMessage = { role: "assistant", content: "The approved operation is complete." };
        const request = {
          model: "gpt-6-astra",
          input: [
            implicitReference,
            approvalRequest,
            approvalResponse,
            { ...customCall, id: "custom_item_a" },
            { ...customOutput, id: "custom_output_item_a" },
            { ...untypedMessage, id: "message_old" },
            { type: "reasoning", id: "reasoning_old" },
          ],
        };
        const original = structuredClone(request);
        mockFetch
          .mockResolvedValueOnce(createFetchResponse({ error: { message: ownershipMessage } }, false, 401))
          .mockResolvedValueOnce(createFetchResponse(successBody));

        await client[method](request);

        expect(JSON.parse(mockFetch.mock.calls[1][1].body).input).toEqual([
          implicitReference,
          approvalRequest,
          approvalResponse,
          customCall,
          customOutput,
          untypedMessage,
        ]);
        expect(request).toEqual(original);
      });

      it("matches the decoded JSON error message", async () => {
        mockFetch
          .mockResolvedValueOnce(new Response(
            String.raw`{"error":{"message":"\u0069nput item does not belong to this connection"}}`,
            { status: 401 },
          ))
          .mockResolvedValueOnce(createFetchResponse(successBody));

        await client[method]({
          model: "gpt-6-astra",
          input: [{ type: "reasoning", encrypted_content: "old_reasoning" }, { role: "user", content: "Continue" }],
        });

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(mockFetch.mock.calls[1][1].body).input).toEqual([{ role: "user", content: "Continue" }]);
      });

      it.each([
        [401, { error: { message: "Token expired" } }],
        [400, { error: { message: "Malformed request" } }],
        [403, { error: { message: ownershipMessage } }],
        [429, { error: { message: ownershipMessage } }],
        [500, { error: { message: ownershipMessage } }],
        [400, { error: { message: `Invalid request: ${ownershipMessage}` } }],
        [401, { error: { message: `${ownershipMessage}. Please sign in.` } }],
        [401, { message: ownershipMessage }],
        [401, { error: { code: ownershipMessage } }],
      ])("does not retry HTTP %i with unrelated or differently shaped errors %j", async (status, errorBody) => {
        mockFetch.mockResolvedValueOnce(createFetchResponse(errorBody, false, status));

        await expect(client[method]({
          model: "gpt-6-astra",
          input: [{ type: "reasoning", id: "rs_old", encrypted_content: "cipher" }],
        })).rejects.toThrow();

        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it("does not match an ownership phrase in a non-JSON error body", async () => {
        mockFetch.mockResolvedValueOnce(new Response(ownershipMessage, { status: 401 }));

        await expect(client[method]({
          model: "gpt-6-astra",
          input: [{ type: "reasoning", id: "rs_old" }],
        })).rejects.toThrow();

        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it.each([
        { name: "a string prompt", input: "Continue" },
        { name: "plain messages", input: [{ role: "user", content: "Continue" }] },
        { name: "a reference that needs its ID", input: [{ type: "item_reference", id: "required_id" }] },
        { name: "a reference without an explicit type", input: [{ id: "required_id" }] },
        { name: "an MCP approval pair", input: [
          { type: "mcp_approval_request", id: "approval_a", name: "read_document", server_label: "documents", arguments: "{}" },
          { type: "mcp_approval_response", approval_request_id: "approval_a", approve: true },
        ] },
        { name: "encrypted compaction without optional IDs", input: [{ type: "compaction", encrypted_content: "essential_context" }] },
        { name: "opaque encrypted history without optional IDs", input: [{ type: "future_history_item", encrypted_content: "essential_context" }] },
        { name: "opaque encrypted history whose ID may be required", input: [{ type: "future_history_item", id: "unknown_required_id", encrypted_content: "essential_context" }] },
      ])("does not retry when $name has no safely removable history", async ({ input }) => {
        mockFetch.mockResolvedValueOnce(createFetchResponse({ error: { message: ownershipMessage } }, false, 401));

        await expect(client[method]({ model: "gpt-6-astra", input })).rejects.toThrow(ownershipMessage);

        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it("surfaces the second ownership failure without making a third request", async () => {
        mockFetch
          .mockResolvedValueOnce(createFetchResponse({ error: { message: ownershipMessage } }, false, 400))
          .mockResolvedValueOnce(createFetchResponse({ error: { message: ownershipMessage, code: "second_failure" } }, false, 401));

        await expect(client[method]({
          model: "gpt-6-astra",
          input: [{ role: "assistant", id: "msg_old", content: "Earlier answer" }],
        })).rejects.toThrow(/second_failure/);

        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it("does not clean history when the initial request succeeds", async () => {
        mockFetch.mockResolvedValueOnce(createFetchResponse(successBody));
        const request = {
          model: "gpt-6-astra",
          input: [{ type: "reasoning", id: "rs_valid", encrypted_content: "valid_cipher" }, { role: "assistant", id: "msg_valid", content: "Earlier answer" }],
        };

        await client[method](request);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ ...request, stream: isStream });
      });
    },
  );
});
