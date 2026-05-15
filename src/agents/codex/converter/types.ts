/**
 * OpenAI Responses API surface — the subset we accept from the Codex CLI
 * and the subset we emit on streaming completions.
 *
 * Hand-typed (we deliberately don't pull in the `openai` SDK as a runtime
 * dependency: it's heavy and we only need the wire schema). The shapes
 * mirror OpenAI's published Responses spec as of 2026-05.
 */

/** Top-level body sent by Codex CLI to POST /codex/v1/responses. */
export interface ResponsesRequest {
  model: string;
  /**
   * Either a single string user prompt OR an ordered list of typed input
   * items. Codex CLI sends arrays; older OpenAI clients send strings.
   */
  input: string | ResponsesInputItem[];
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: ResponsesTool[];
  tool_choice?: ResponsesToolChoice;
  parallel_tool_calls?: boolean;
  reasoning?: {
    /** "low" | "medium" | "high" | "none" */
    effort?: string;
    /** "auto" | "concise" | "detailed" | null */
    summary?: string | null;
  };
  /** We refuse these — see route handler. */
  previous_response_id?: string;
  conversation?: unknown;
  /** Pass-through fields we don't care about. */
  metadata?: Record<string, unknown>;
}

/** One element of the `input` array. */
export type ResponsesInputItem =
  | ResponsesMessageInput
  | ResponsesFunctionCallInput
  | ResponsesFunctionCallOutputInput;

export interface ResponsesMessageInput {
  type?: "message"; // Codex frequently omits this for plain message items
  role: "system" | "developer" | "user" | "assistant";
  content: string | ResponsesContentPart[];
}

export interface ResponsesFunctionCallInput {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionCallOutputInput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | {
      type: "input_image";
      image_url?: string;
      detail?: "low" | "high" | "auto";
    };

export interface ResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export type ResponsesToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string };

// ---------- Response shapes (non-streaming) ----------

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "in_progress" | "failed";
  model: string;
  output: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
  };
  error?: { code: string; message: string } | null;
  /** Default; we don't preserve any internal IDs across requests. */
  conversation_id?: string | null;
}

export type ResponsesOutputItem =
  | {
      id: string;
      type: "message";
      role: "assistant";
      status: "completed";
      content: Array<{ type: "output_text"; text: string }>;
    }
  | {
      id: string;
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
      status: "completed";
    };

// ---------- Streaming events ----------

/**
 * Events emitted by our SSE transformer. Each carries a monotonic
 * `sequence_number` that Codex CLI relies on to order chunks.
 */
export type ResponsesStreamEvent =
  | {
      type: "response.created";
      sequence_number: number;
      response: ResponsesResponse;
    }
  | {
      type: "response.in_progress";
      sequence_number: number;
      response: ResponsesResponse;
    }
  | {
      type: "response.output_item.added";
      sequence_number: number;
      output_index: number;
      item: ResponsesOutputItem;
    }
  | {
      type: "response.content_part.added";
      sequence_number: number;
      output_index: number;
      content_index: number;
      part: { type: "output_text"; text: "" };
    }
  | {
      type: "response.output_text.delta";
      sequence_number: number;
      output_index: number;
      content_index: number;
      delta: string;
    }
  | {
      type: "response.content_part.done";
      sequence_number: number;
      output_index: number;
      content_index: number;
      part: { type: "output_text"; text: string };
    }
  | {
      type: "response.output_item.done";
      sequence_number: number;
      output_index: number;
      item: ResponsesOutputItem;
    }
  | {
      type: "response.function_call_arguments.delta";
      sequence_number: number;
      output_index: number;
      delta: string;
    }
  | {
      type: "response.function_call_arguments.done";
      sequence_number: number;
      output_index: number;
      arguments: string;
    }
  | {
      type: "response.completed";
      sequence_number: number;
      response: ResponsesResponse;
    }
  | {
      type: "response.failed";
      sequence_number: number;
      response: ResponsesResponse;
    };
