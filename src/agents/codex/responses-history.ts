/** Request-local recovery for Copilot history issued to another connection. */
export function isHistoryOwnershipError(status: number, text: string): boolean {
  if (status !== 400 && status !== 401) return false;
  try {
    const message = JSON.parse(text)?.error?.message;
    return message === "input item does not belong to this connection" ||
      message === "input item ID does not belong to this connection";
  } catch {
    return false;
  }
}

interface HistoryRecovery {
  body: Record<string, unknown>;
  removedIds: number;
  removedReasoning: number;
}

const OPTIONAL_ID_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "compaction",
  "compaction_summary",
  "context_compaction",
]);

/**
 * Rebuild only the transport state that can be discarded without removing
 * conversation text or tool results. The caller's saved history is never edited.
 *
 * Reasoning ciphertext can itself be connection-bound, even without an item ID.
 * Compaction and other encrypted content may be the only remaining copy of
 * earlier context, so they must survive this retry. An item_reference also needs
 * its ID: it has no inline content from which we could reconstruct the item.
 */
export function prepareHistoryRecovery(body: unknown): HistoryRecovery | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const request = body as Record<string, unknown>;
  if (!Array.isArray(request.input)) return null;

  let removedIds = 0;
  let removedReasoning = 0;
  const input: unknown[] = [];
  for (const item of request.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      input.push(item);
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type === "reasoning") {
      removedReasoning++;
      continue;
    }
    // ItemReference.type can be omitted, and IDs on other item types can
    // participate in links (for example MCP approval_request_id). Only strip
    // known optional IDs, not every object that happens to have an `id` field.
    const inlineMessage = record.type === undefined &&
      typeof record.role === "string" && Object.hasOwn(record, "content");
    const optionalId = inlineMessage ||
      (typeof record.type === "string" && OPTIONAL_ID_TYPES.has(record.type));
    if (optionalId && Object.hasOwn(record, "id")) {
      const { id: _id, ...replayable } = record;
      input.push(replayable);
      removedIds++;
    } else {
      input.push(item);
    }
  }

  if (removedIds === 0 && removedReasoning === 0) return null;
  return { body: { ...request, input }, removedIds, removedReasoning };
}
