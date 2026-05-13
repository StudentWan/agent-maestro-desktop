export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string; cache_control?: unknown }>;
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicToolDef[];
  tool_choice?: { type: string; name?: string };
  metadata?: Record<string, unknown>;
  thinking?: AnthropicThinkingConfig;
  output_config?: AnthropicOutputConfig;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
  cache_control?: unknown;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  is_error?: boolean;
  cache_control?: unknown;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
  cache_control?: unknown;
  [key: string]: unknown;
}

export interface AnthropicThinkingConfig {
  type: string;
  budget_tokens?: number;
  [key: string]: unknown;
}

export interface AnthropicOutputConfig {
  effort?: "low" | "medium" | "high";
  [key: string]: unknown;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation?: unknown;
    server_tool_use?: unknown;
    service_tier?: string | null;
  };
}

export type AnthropicResponseBlock =
  | { type: "text"; text: string; citations?: unknown }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

// SSE event types for streaming
export interface AnthropicSSEEvent {
  event: string;
  data: string;
}
