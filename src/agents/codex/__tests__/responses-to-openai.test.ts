import { describe, expect, it } from "vitest";
import {
  ResponsesRequestError,
  convertResponsesToOpenAI,
} from "../converter/responses-to-openai";
import type { ResponsesRequest } from "../converter/types";

describe("convertResponsesToOpenAI", () => {
  it("flattens a string `input` into a single user message after instructions", () => {
    const result = convertResponsesToOpenAI({
      model: "gpt-5",
      input: "hello world",
      instructions: "you are helpful",
    });
    expect(result).toMatchObject({
      model: "gpt-5",
      stream: false,
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello world" },
      ],
    });
  });

  it("converts an array of message items including content parts", () => {
    const req: ResponsesRequest = {
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "tell me about " },
            { type: "input_text", text: "rust" },
            { type: "input_image", image_url: "https://x.test/a.png" },
          ],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "rust is..." }],
        },
        {
          role: "developer",
          content: "be brief",
        },
      ],
    };
    const result = convertResponsesToOpenAI(req);
    expect(result.messages).toEqual([
      { role: "user", content: "tell me about rust[Image content omitted]" },
      { role: "assistant", content: "rust is..." },
      // `developer` is collapsed to `system` for ChatCompletions.
      { role: "system", content: "be brief" },
    ]);
  });

  it("translates function_call + function_call_output into assistant + tool roles", () => {
    const req: ResponsesRequest = {
      model: "gpt-5",
      input: [
        { role: "user", content: "what's the weather in Tokyo?" },
        {
          type: "function_call",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"city":"Tokyo"}',
        },
        {
          type: "function_call_output",
          call_id: "call_abc",
          output: '{"temp":20}',
        },
      ],
    };
    const result = convertResponsesToOpenAI(req);
    expect(result.messages).toEqual([
      { role: "user", content: "what's the weather in Tokyo?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
      {
        role: "tool",
        content: '{"temp":20}',
        tool_call_id: "call_abc",
      },
    ]);
  });

  it("converts tools and tool_choice to the OpenAI ChatCompletions shape", () => {
    const req: ResponsesRequest = {
      model: "gpt-5",
      input: "hi",
      tools: [
        {
          type: "function",
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      tool_choice: { type: "function", name: "search" },
    };
    const result = convertResponsesToOpenAI(req);
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ]);
    expect(result.tool_choice).toEqual({
      type: "function",
      function: { name: "search" },
    });
  });

  it("maps max_output_tokens → max_tokens and forwards stream/temperature/top_p", () => {
    const result = convertResponsesToOpenAI({
      model: "gpt-5",
      input: "hi",
      max_output_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
    });
    expect(result.max_tokens).toBe(1024);
    expect(result.temperature).toBe(0.2);
    expect(result.top_p).toBe(0.9);
    expect(result.stream).toBe(true);
  });

  it("rejects previous_response_id with HTTP 400", () => {
    expect(() =>
      convertResponsesToOpenAI({
        model: "gpt-5",
        input: "hi",
        previous_response_id: "resp_abc",
      }),
    ).toThrow(ResponsesRequestError);
  });

  it("rejects conversation with HTTP 400", () => {
    expect(() =>
      convertResponsesToOpenAI({
        model: "gpt-5",
        input: "hi",
        conversation: { id: "conv_1" },
      }),
    ).toThrow(ResponsesRequestError);
  });

  it("emits an empty user turn when input is an empty array (defensive)", () => {
    const result = convertResponsesToOpenAI({
      model: "gpt-5",
      input: [],
    });
    expect(result.messages).toEqual([{ role: "user", content: "" }]);
  });

  it("drops non-function tools silently rather than failing", () => {
    const req = {
      model: "gpt-5",
      input: "hi",
      tools: [
        // Cast: shape isn't on our public type union but real Codex CLI
        // request bodies sometimes contain these built-in tool kinds.
        { type: "web_search_preview", name: "web_search" },
        { type: "function", name: "real_tool" },
      ],
    } as unknown as ResponsesRequest;
    const result = convertResponsesToOpenAI(req);
    expect(result.tools).toHaveLength(1);
    expect(result.tools?.[0].function.name).toBe("real_tool");
  });

  it("groups consecutive parallel function_call items into one assistant message and drops empty assistant turns", () => {
    const req: ResponsesRequest = {
      model: "gemini-4-hydrogen",
      input: [
        { role: "user", content: "check both files" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "exec_command",
          arguments: '{"cmd":"ls a"}',
        },
        {
          type: "function_call",
          call_id: "call_2",
          name: "exec_command",
          arguments: '{"cmd":"ls b"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "a.txt",
        },
        {
          type: "function_call_output",
          call_id: "call_2",
          output: "b.txt",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
        },
        { role: "user", content: "continue" },
      ],
    };

    const result = convertResponsesToOpenAI(req);
    expect(result.messages).toEqual([
      { role: "user", content: "check both files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "exec_command", arguments: '{"cmd":"ls a"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "exec_command", arguments: '{"cmd":"ls b"}' },
          },
        ],
      },
      { role: "tool", content: "a.txt", tool_call_id: "call_1" },
      { role: "tool", content: "b.txt", tool_call_id: "call_2" },
      { role: "user", content: "continue" },
    ]);
  });

  it("drops namespace and tool_search tools and deduplicates function names for ChatCompletions", () => {
    const req = {
      model: "gemini-4-hydrogen",
      input: "hi",
      tools: [
        { type: "tool_search" },
        {
          type: "namespace",
          name: "mcp",
          tools: [{ type: "function", name: "mcp__read", description: "read" }],
        },
        { type: "function", name: "exec_command", description: "run" },
        { type: "function", name: "exec_command", description: "dup" },
      ],
    } as unknown as ResponsesRequest;

    const result = convertResponsesToOpenAI(req);
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "exec_command",
          description: "run",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("stringifies multimodal array function_call_output (e.g. view_image) into string tool content", () => {
    const req: ResponsesRequest = {
      model: "gemini-4-hydrogen",
      input: [
        { role: "user", content: "check screenshot" },
        {
          type: "function_call",
          call_id: "call_img",
          name: "view_image",
          arguments: '{"path":"shot.png"}',
        },
        {
          type: "function_call_output",
          call_id: "call_img",
          output: [
            { type: "input_text", text: "Loaded image: " },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
    };

    const result = convertResponsesToOpenAI(req);
    expect(result.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_img",
      content: "Loaded image: [Image content omitted]",
    });
  });

  it("converts standalone function_call_output without call_id (e.g. Codex App agent/browser_tabs) into user context instead of invalid tool role", () => {
    const req: ResponsesRequest = {
      model: "gemini-4-hydrogen",
      input: [
        { role: "user", content: "inspect open tabs" },
        {
          type: "function_call_output",
          id: "fco_01a1ed68",
          name: "browser_tabs",
          namespace: "agent",
          output: '{"tabs":[{"title":"Docs","url":"https://example.com"}]}',
        },
        { role: "user", content: "summarize" },
      ],
    };

    const result = convertResponsesToOpenAI(req);
    expect(result.messages).toEqual([
      { role: "user", content: "inspect open tabs" },
      {
        role: "user",
        content:
          '[Tool output: agent/browser_tabs]\n{"tabs":[{"title":"Docs","url":"https://example.com"}]}',
      },
      { role: "user", content: "summarize" },
    ]);
  });

  it("converts orphaned function_call_output whose call_id has no preceding function_call into user context", () => {
    const req: ResponsesRequest = {
      model: "gemini-4-hydrogen",
      input: [
        {
          type: "function_call_output",
          call_id: "call_compacted_away",
          output: "previous command output",
        },
        { role: "user", content: "what failed?" },
      ],
    };

    const result = convertResponsesToOpenAI(req);
    expect(result.messages).toEqual([
      {
        role: "user",
        content: "[Tool output: call_compacted_away]\nprevious command output",
      },
      { role: "user", content: "what failed?" },
    ]);
  });

  it("synthesizes matching tool responses for unanswered or call_id-less function_call items", () => {
    const req: ResponsesRequest = {
      model: "gemini-4-hydrogen",
      input: [
        { role: "user", content: "delegate task" },
        {
          type: "function_call",
          call_id: "call_spawn_1",
          name: "spawn_agent",
          arguments: '{"prompt":"subtask"}',
        },
        {
          type: "function_call",
          name: "missing_id_tool",
          arguments: "{}",
        },
        { role: "developer", content: "subagent forked" },
        { role: "user", content: "continue" },
      ],
    };

    const result = convertResponsesToOpenAI(req);
    expect(result.messages).toEqual([
      { role: "user", content: "delegate task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_spawn_1",
            type: "function",
            function: { name: "spawn_agent", arguments: '{"prompt":"subtask"}' },
          },
          {
            id: "call_missing_2",
            type: "function",
            function: { name: "missing_id_tool", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_spawn_1",
        content: "[No tool output recorded]",
      },
      {
        role: "tool",
        tool_call_id: "call_missing_2",
        content: "[No tool output recorded]",
      },
      { role: "system", content: "subagent forked" },
      { role: "user", content: "continue" },
    ]);
  });

  it("keeps assistant.tool_calls adjacent to tool responses when reasoning or steering messages appear mid-turn", () => {
    const req = {
      model: "gemini-4-hydrogen",
      input: [
        { role: "user", content: "run checks" },
        {
          type: "function_call",
          call_id: "call_a",
          name: "exec_command",
          arguments: '{"cmd":"npm test"}',
        },
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "checking lint too" }],
        },
        {
          type: "function_call",
          call_id: "call_b",
          name: "exec_command",
          arguments: '{"cmd":"npm run lint"}',
        },
        { role: "user", content: "also check types" },
        {
          type: "function_call_output",
          call_id: "call_b",
          output: "lint clean",
        },
        {
          type: "function_call_output",
          call_id: "call_a",
          output: "tests passed",
        },
      ],
    } as unknown as ResponsesRequest;

    const result = convertResponsesToOpenAI(req);
    expect(result.messages).toEqual([
      { role: "user", content: "run checks" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: { name: "exec_command", arguments: '{"cmd":"npm test"}' },
          },
          {
            id: "call_b",
            type: "function",
            function: {
              name: "exec_command",
              arguments: '{"cmd":"npm run lint"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "tests passed" },
      { role: "tool", tool_call_id: "call_b", content: "lint clean" },
      { role: "user", content: "also check types" },
    ]);
  });

  it("converts custom_tool_call + custom_tool_call_output from prior GPT turns when switching to ChatCompletions models", () => {
    const req: ResponsesRequest = {
      model: "gemini-4-hydrogen",
      input: [
        { role: "user", content: "patch file" },
        {
          type: "custom_tool_call",
          call_id: "call_patch_1",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_patch_1",
          output: "Success. Updated files.",
        },
        { role: "user", content: "verify" },
      ],
    };

    const result = convertResponsesToOpenAI(req);
    expect(result.messages).toEqual([
      { role: "user", content: "patch file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_patch_1",
            type: "function",
            function: {
              name: "apply_patch",
              arguments: JSON.stringify({
                input: "*** Begin Patch\n*** End Patch",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_patch_1",
        content: "Success. Updated files.",
      },
      { role: "user", content: "verify" },
    ]);
  });
});
