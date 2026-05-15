import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicToolDef,
} from "./converter/types";

const MAX_CACHE_CONTROL_MARKERS = 4;
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;

type SystemTextBlock = { type: string; text: string; cache_control?: unknown };
type CacheableContentBlock = Extract<
  AnthropicContentBlock,
  { type: "text" } | { type: "image" } | { type: "tool_result" }
>;

interface CacheMarkerBudget {
  used: number;
}

export function applyCopilotPromptCache(request: AnthropicRequest): AnthropicRequest {
  const budget: CacheMarkerBudget = { used: countCacheControlMarkers(request) };
  let nextRequest: AnthropicRequest = { ...request };

  const tools = applyCacheControlToLastTool(request.tools, budget);
  if (tools !== request.tools) {
    nextRequest = { ...nextRequest, tools };
  }

  const system = applyCacheControlToSystem(request.system, budget);
  if (system !== request.system) {
    nextRequest = { ...nextRequest, system };
  }

  const messages = applyCacheControlToTrailingUserMessage(request.messages, budget);
  if (messages !== request.messages) {
    nextRequest = { ...nextRequest, messages };
  }

  return nextRequest;
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
