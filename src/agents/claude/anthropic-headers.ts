/**
 * Claude-specific extensions to the generic Copilot HTTP headers.
 *
 * These live in the Claude plugin (not in `src/copilot/headers.ts`)
 * because they reference the Anthropic Messages request shape and the
 * `anthropic-beta` header — neither has any meaning for Codex or any
 * other future agent.
 */
import { v4 as uuidv4 } from "uuid";
import { buildCopilotHeaders } from "../../copilot/headers";
import type { AnthropicRequest } from "./converter/types";

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
  // Start from the generic Copilot headers, then override / add the
  // Anthropic-specific fields. This keeps the editor / org / integration
  // headers in one place (src/copilot/headers.ts) while letting Claude
  // own the Anthropic protocol surface.
  const base = buildCopilotHeaders(copilotToken);
  const anthropicBeta = filterCopilotAnthropicBeta(options.anthropicBeta);
  return {
    ...base,
    "X-Request-Id": uuidv4(),
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
