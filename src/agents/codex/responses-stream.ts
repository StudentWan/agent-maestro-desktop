import { createParser, type EventSourceParser } from "eventsource-parser";

/**
 * Copilot can return a different opaque ID in every event for the same
 * output item. Codex needs a stable ID to reconcile deltas with the final
 * item; otherwise a streamed progress message can appear twice.
 *
 * Keep the first upstream ID per output_index, including in response
 * snapshots. Keep actual upstream IDs (rather than synthesizing them) so
 * items remain usable in subsequent requests. Never rewrite call_id or
 * encrypted_content. Each HTTP stream owns its own mapping.
 */
export function createResponsesItemIdNormalizer(): TransformStream<
  Uint8Array,
  string
> {
  const itemIds = new Map<number, string>();
  const decoder = new TextDecoder();
  let parser: EventSourceParser;

  function normalizeId(
    target: Record<string, unknown>,
    key: string,
    index: number,
  ): boolean {
    const id = target[key];
    if (typeof id !== "string" || id.length === 0) return false;
    const canonical = itemIds.get(index);
    if (canonical === undefined) {
      itemIds.set(index, id);
      return false;
    }
    if (id === canonical) return false;
    target[key] = canonical;
    return true;
  }

  function normalizeData(data: string): string {
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      // Preserve non-JSON events, including [DONE], for the downstream client.
      return data;
    }
    if (
      !isRecord(event) ||
      typeof event.type !== "string" ||
      !event.type.startsWith("response.")
    ) {
      return data;
    }

    if (event.type === "response.created") itemIds.clear();
    let changed = false;
    const index = event.output_index;
    if (
      typeof index === "number" &&
      Number.isSafeInteger(index) &&
      index >= 0
    ) {
      if (isRecord(event.item))
        changed = normalizeId(event.item, "id", index) || changed;
      changed = normalizeId(event, "item_id", index) || changed;
    }

    // completed/incomplete/failed can all carry final output snapshots.
    if (isRecord(event.response) && Array.isArray(event.response.output)) {
      event.response.output.forEach((item, outputIndex) => {
        if (isRecord(item))
          changed = normalizeId(item, "id", outputIndex) || changed;
      });
    }
    return changed ? JSON.stringify(event) : data;
  }

  return new TransformStream<Uint8Array, string>({
    start(controller) {
      parser = createParser({
        onEvent(event) {
          const lines: string[] = [];
          if (event.event !== undefined) lines.push(`event: ${event.event}`);
          if (event.id !== undefined) lines.push(`id: ${event.id}`);
          for (const line of normalizeData(event.data).split("\n")) {
            lines.push(`data: ${line}`);
          }
          controller.enqueue(`${lines.join("\n")}\n\n`);
        },
        onComment(comment) {
          controller.enqueue(`: ${comment}\n\n`);
        },
        onRetry(retry) {
          controller.enqueue(`retry: ${retry}\n\n`);
        },
      });
    },
    transform(chunk) {
      parser.feed(decoder.decode(chunk, { stream: true }));
    },
    flush() {
      // Also handle a final event without the customary empty trailing line.
      parser.feed(`${decoder.decode()}\n\n`);
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
