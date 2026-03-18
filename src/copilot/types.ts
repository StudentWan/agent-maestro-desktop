export interface CopilotToken {
  token: string;
  expiresAt: number;
}

export interface DeviceFlowState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface CopilotCompletionRequest {
  model: string;
  messages: CopilotMessage[];
  stream: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  n?: number;
  stop?: string | string[];
  tools?: CopilotTool[];
  tool_choice?: string | { type: string; function?: { name: string } };
}

export interface CopilotMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: CopilotToolCall[];
  tool_call_id?: string;
}

export interface CopilotToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CopilotTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface CopilotCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CopilotChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface CopilotChoice {
  index: number;
  message?: CopilotMessage;
  delta?: Partial<CopilotMessage>;
  finish_reason: string | null;
}

export interface CopilotStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CopilotStreamChoice[];
}

export interface CopilotStreamChoice {
  index: number;
  delta: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason: string | null;
}
