import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicToolDef,
} from "./converter/types";

const MAX_CACHE_CONTROL_MARKERS = 4;
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;

/**
 * Reduce a Claude-Code-supplied `cache_control` value to the strict subset
 * Copilot's Anthropic Messages endpoint accepts.
 *
 * Recent versions of Claude Code add forward-looking sub-fields to the
 * marker (e.g. `cache_control.ephemeral.scope = "session"`, future `ttl`).
 * Anthropic's own API tolerates them, but Copilot's endpoint validates the
 * shape strictly and rejects the whole request with HTTP 400 / `Extra
 * inputs are not permitted`. Until Copilot tracks the upstream schema, we
 * have to strip everything except `type` from any marker before sending.
 *
 * Returns `undefined` (caller treats as "no marker") when the input isn't
 * recognisably a cache marker at all.
 */
function sanitizeCacheControl(value: unknown): { type: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0) return undefined;
  return { type };
}

type SystemTextBlock = { type: string; text: string; cache_control?: unknown };
type CacheableContentBlock = Extract<
  AnthropicContentBlock,
  { type: "text" } | { type: "image" } | { type: "tool_result" }
>;

interface CacheMarkerBudget {
  used: number;
}

export function applyCopilotPromptCache(request: AnthropicRequest): AnthropicRequest {
  // Step 1: normalise any pre-existing cache_control markers to the
  // {type:"ephemeral"} shape Copilot accepts. Claude Code attaches
  // markers itself (with TTL/scope sub-fields Copilot rejects), so this
  // has to happen BEFORE we count markers — otherwise the sanitised
  // marker count and the wire-format marker count diverge.
  const sanitizedRequest = sanitizeRequestCacheControl(request);

  const budget: CacheMarkerBudget = { used: countCacheControlMarkers(sanitizedRequest) };
  let nextRequest: AnthropicRequest = { ...sanitizedRequest };

  const tools = applyCacheControlToLastTool(sanitizedRequest.tools, budget);
  if (tools !== sanitizedRequest.tools) {
    nextRequest = { ...nextRequest, tools };
  }

  const system = applyCacheControlToSystem(sanitizedRequest.system, budget);
  if (system !== sanitizedRequest.system) {
    nextRequest = { ...nextRequest, system };
  }

  const messages = applyCacheControlToTrailingUserMessage(sanitizedRequest.messages, budget);
  if (messages !== sanitizedRequest.messages) {
    nextRequest = { ...nextRequest, messages };
  }

  return nextRequest;
}

/**
 * Walk every place a cache_control marker can live and reduce each one to
 * the {type} subset Copilot's Anthropic Messages endpoint accepts. Returns
 * a new request only if anything actually changed (stable identity for the
 * common no-op case).
 */
function sanitizeRequestCacheControl(request: AnthropicRequest): AnthropicRequest {
  let changed = false;
  let nextRequest: AnthropicRequest = request;

  if (Array.isArray(request.system)) {
    let systemChanged = false;
    const nextSystem = request.system.map((block) => {
      if (block.cache_control === undefined) return block;
      const sanitized = sanitizeCacheControl(block.cache_control);
      if (sanitized === undefined) {
        systemChanged = true;
        const { cache_control: _drop, ...rest } = block;
        return rest;
      }
      if (markerEquals(block.cache_control, sanitized)) return block;
      systemChanged = true;
      return { ...block, cache_control: sanitized };
    });
    if (systemChanged) {
      nextRequest = { ...nextRequest, system: nextSystem };
      changed = true;
    }
  }

  if (request.tools) {
    let toolsChanged = false;
    const nextTools = request.tools.map((tool) => {
      if (tool.cache_control === undefined) return tool;
      const sanitized = sanitizeCacheControl(tool.cache_control);
      if (sanitized === undefined) {
        toolsChanged = true;
        const { cache_control: _drop, ...rest } = tool;
        return rest;
      }
      if (markerEquals(tool.cache_control, sanitized)) return tool;
      toolsChanged = true;
      return { ...tool, cache_control: sanitized };
    });
    if (toolsChanged) {
      nextRequest = { ...nextRequest, tools: nextTools };
      changed = true;
    }
  }

  let messagesChanged = false;
  const nextMessages = request.messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    let contentChanged = false;
    const nextContent = message.content.map((block) => {
      if (!("cache_control" in block) || block.cache_control === undefined) {
        return block;
      }
      const sanitized = sanitizeCacheControl(block.cache_control);
      if (sanitized === undefined) {
        contentChanged = true;
        const { cache_control: _drop, ...rest } = block as unknown as {
          cache_control?: unknown;
        } & Record<string, unknown>;
        return rest as unknown as typeof block;
      }
      if (markerEquals(block.cache_control, sanitized)) return block;
      contentChanged = true;
      return { ...block, cache_control: sanitized };
    });
    if (!contentChanged) return message;
    messagesChanged = true;
    return { ...message, content: nextContent };
  });
  if (messagesChanged) {
    nextRequest = { ...nextRequest, messages: nextMessages };
    changed = true;
  }

  return changed ? nextRequest : request;
}

function markerEquals(a: unknown, b: { type: string }): boolean {
  if (!a || typeof a !== "object") return false;
  const aObj = a as Record<string, unknown>;
  const keys = Object.keys(aObj);
  return keys.length === 1 && keys[0] === "type" && aObj.type === b.type;
}

export function countCacheControlMarkers(request: AnthropicRequest): number {
  let count = 0;

  if (Array.isArray(request.system)) {
    count += request.system.filter((block) => block.cache_control !== undefined).length;
  }

  if (request.tools) {
    count += request.tools.filter((tool) => tool.cache_control !== undefined).length;
  }

  for (const message of request.messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    count += message.content.filter((block) => "cache_control" in block && block.cache_control !== undefined).length;
  }

  return count;
}

function canAddMarker(budget: CacheMarkerBudget): boolean {
  return budget.used < MAX_CACHE_CONTROL_MARKERS;
}

function consumeMarker(budget: CacheMarkerBudget): typeof EPHEMERAL_CACHE_CONTROL | undefined {
  if (!canAddMarker(budget)) {
    return undefined;
  }
  budget.used += 1;
  return EPHEMERAL_CACHE_CONTROL;
}

function applyCacheControlToLastTool(
  tools: AnthropicToolDef[] | undefined,
  budget: CacheMarkerBudget,
): AnthropicToolDef[] | undefined {
  if (!tools || tools.length === 0 || !canAddMarker(budget)) {
    return tools;
  }

  const lastIndex = tools.length - 1;
  const lastTool = tools[lastIndex];
  if (!lastTool || lastTool.cache_control !== undefined) {
    return tools;
  }

  const cacheControl = consumeMarker(budget);
  if (!cacheControl) {
    return tools;
  }

  const nextTools = [...tools];
  nextTools[lastIndex] = { ...lastTool, cache_control: cacheControl };
  return nextTools;
}

function applyCacheControlToSystem(
  system: AnthropicRequest["system"],
  budget: CacheMarkerBudget,
): AnthropicRequest["system"] {
  if (!system || !canAddMarker(budget)) {
    return system;
  }

  const cacheControl = consumeMarker(budget);
  if (!cacheControl) {
    return system;
  }

  if (typeof system === "string") {
    return [{ type: "text", text: system, cache_control: cacheControl }];
  }

  const lastTextIndex = findLastIndex(system, isSystemTextBlock);
  if (lastTextIndex === -1) {
    budget.used -= 1;
    return system;
  }

  const lastTextBlock = system[lastTextIndex];
  if (!lastTextBlock || lastTextBlock.cache_control !== undefined) {
    budget.used -= 1;
    return system;
  }

  const nextSystem = [...system];
  nextSystem[lastTextIndex] = { ...lastTextBlock, cache_control: cacheControl };
  return nextSystem;
}

function applyCacheControlToTrailingUserMessage(
  messages: AnthropicMessage[],
  budget: CacheMarkerBudget,
): AnthropicMessage[] {
  if (messages.length === 0 || !canAddMarker(budget)) {
    return messages;
  }

  const lastIndex = messages.length - 1;
  const lastMessage = messages[lastIndex];
  if (!lastMessage || lastMessage.role !== "user") {
    return messages;
  }

  const nextMessage = applyCacheControlToUserMessage(lastMessage, budget);
  if (nextMessage === lastMessage) {
    return messages;
  }

  const nextMessages = [...messages];
  nextMessages[lastIndex] = nextMessage;
  return nextMessages;
}

function applyCacheControlToUserMessage(
  message: AnthropicMessage,
  budget: CacheMarkerBudget,
): AnthropicMessage {
  const cacheControl = consumeMarker(budget);
  if (!cacheControl) {
    return message;
  }

  if (typeof message.content === "string") {
    return {
      ...message,
      content: [{ type: "text", text: message.content, cache_control: cacheControl }],
    };
  }

  const cacheableIndex = findLastIndex(message.content, isCacheableUserBlock);
  if (cacheableIndex === -1) {
    budget.used -= 1;
    return message;
  }

  const block = message.content[cacheableIndex];
  if (!block || !isCacheableUserBlock(block) || block.cache_control !== undefined) {
    budget.used -= 1;
    return message;
  }

  const nextContent = [...message.content];
  nextContent[cacheableIndex] = { ...block, cache_control: cacheControl };
  return { ...message, content: nextContent };
}

function isSystemTextBlock(block: unknown): block is SystemTextBlock {
  return Boolean(block) && typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string";
}

function isCacheableUserBlock(block: AnthropicContentBlock): block is CacheableContentBlock {
  return block.type === "text" || block.type === "image" || block.type === "tool_result";
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}
