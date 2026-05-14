import { v4 as uuidv4 } from "uuid";
import {
  APP_USER_AGENT,
  EDITOR_VERSION,
  EDITOR_PLUGIN_VERSION,
  MACHINE_ID,
} from "../shared/constants";
import type { AnthropicRequest } from "../converter/types";

/**
 * Build the required headers for Copilot API requests
 */
export function buildCopilotHeaders(copilotToken: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${copilotToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Accept-Encoding": "gzip, deflate, br",
    "Editor-Version": EDITOR_VERSION,
    "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
    "User-Agent": APP_USER_AGENT,
    "X-Request-Id": uuidv4(),
    "Openai-Organization": "github-copilot",
    "Openai-Intent": "conversation-panel",
    "VScode-SessionId": uuidv4(),
    "VScode-MachineId": MACHINE_ID,
    "Copilot-Integration-Id": "vscode-chat",
  };
}

/**
 * Build headers for streaming requests
 */
export function buildCopilotStreamHeaders(copilotToken: string): Record<string, string> {
  return {
    ...buildCopilotHeaders(copilotToken),
    "Accept": "text/event-stream",
  };
}

export interface CopilotAnthropicHeaderOptions {
  anthropicBeta?: string;
}

export function hasContext1mBeta(anthropicBeta?: string): boolean {
  return parseAnthropicBeta(anthropicBeta).some((beta) => /^context-1m(?:-|$)/.test(beta));
}

export function filterCopilotAnthropicBeta(anthropicBeta?: string): string | undefined {
  const supportedBetas = parseAnthropicBeta(anthropicBeta).filter(
    (beta) => !/^context-1m(?:-|$)/.test(beta),
  );
  return supportedBetas.length > 0 ? supportedBetas.join(",") : undefined;
}

export function buildCopilotAnthropicHeaders(
  copilotToken: string,
  request: AnthropicRequest,
  options: CopilotAnthropicHeaderOptions = {},
): Record<string, string> {
  const anthropicBeta = filterCopilotAnthropicBeta(options.anthropicBeta);
  return {
    "Authorization": `Bearer ${copilotToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Editor-Version": EDITOR_VERSION,
    "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
    "User-Agent": APP_USER_AGENT,
    "X-Request-Id": uuidv4(),
    "Openai-Organization": "github-copilot",
    "Copilot-Integration-Id": "vscode-chat",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-initiator": inferCopilotInitiator(request),
    ...(hasVisionInput(request) ? { "Copilot-Vision-Request": "true" } : {}),
    ...(anthropicBeta ? { "anthropic-beta": anthropicBeta } : {}),
  };
}

function parseAnthropicBeta(anthropicBeta?: string): string[] {
  return anthropicBeta?.split(",").map((beta) => beta.trim()).filter(Boolean) ?? [];
}

function inferCopilotInitiator(request: AnthropicRequest): "agent" | "user" {
  const last = request.messages[request.messages.length - 1];
  if (!last || last.role !== "user") {
    return "agent";
  }
  return containsAnthropicContentType(last.content, "tool_result") ? "agent" : "user";
}

function hasVisionInput(request: AnthropicRequest): boolean {
  return request.messages.some((message) => containsAnthropicContentType(message.content, "image"));
}

function containsAnthropicContentType(value: unknown, type: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsAnthropicContentType(item, type));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as { type?: unknown; content?: unknown };
  return entry.type === type || containsAnthropicContentType(entry.content, type);
}
