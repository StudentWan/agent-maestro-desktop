import type { CopilotStreamChoice } from "../../../copilot/types";
import type {
  ResponsesOutputItem,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "./types";

/**
 * Transform a Copilot SSE stream (OpenAI ChatCompletions `delta` events)
 * into the OpenAI Responses event sequence that Codex CLI expects.
 *
 * Sequence shape we emit (a single text response with no tool calls):
 *   response.created
 *   response.in_progress
 *   response.output_item.added       (item.type = "message")
 *   response.content_part.added      (part.type = "output_text", text="")
 *   response.output_text.delta * N
 *   response.content_part.done
 *   response.output_item.done
 *   response.completed
 *
 * For tool calls, in lieu of message events we emit:
 *   response.output_item.added       (item.type = "function_call")
 *   response.function_call_arguments.delta * N
 *   response.function_call_arguments.done
 *   response.output_item.done
 *
 * Text + tool calls can interleave; we close any open block before opening
 * the next one. Each item gets its own monotonically-increasing
 * `output_index`. `sequence_number` is monotonic across the entire stream
 * — Codex CLI relies on it to order chunks.
 *
 * On the wire, every event is serialized as
 *   event: <type>\ndata: <json>\n\n
 * which matches Codex's SSE parser exactly (it ignores the event line
 * and parses the JSON, but emitting it keeps the bytes inspectable).
 */
export function createResponsesStreamTransformer(
  originalModel: string,
): TransformStream<Uint8Array, string> {
  let sequence = 0;
  let outputIndex = -1;

  const responseId = `resp_${Date.now()}`;
  const createdAt = Math.floor(Date.now() / 1000);

  // A snapshot of the response we publish in `response.created` /
  // `response.in_progress` / `response.completed`. We mutate `output` /
  // `status` as we go — the transformer mirrors what the non-streaming
  // converter would have produced for the final state.
  const responseSnapshot: ResponsesResponse = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model: originalModel,
    output: [],
    usage: undefined,
    error: null,
    conversation_id: null,
  };

  // Buffer for the current open block. We can have at most one open block
  // at a time across both kinds.
  type OpenBlock =
    | {
        kind: "text";
        outputIndex: number;
        itemId: string;
        contentIndex: number;
        accumulated: string;
      }
    | {
        kind: "tool";
        outputIndex: number;
        itemId: string;
        callId: string;
        name: string;
        accumulatedArgs: string;
      };
  let open: OpenBlock | null = null;

  // Map OpenAI tool_call index → our open tool block, so subsequent argument
  // chunks for the same call land on the same block even if other deltas
  // arrive between them.
  const toolBlocksByIndex = new Map<number, Extract<OpenBlock, { kind: "tool" }>>();

  let messageStarted = false;
  let finishReason: string | null = null;
  let usage: ResponsesResponse["usage"];
  let completed = false;
  let sentInitial = false;

  function nextSeq(): number {
    return sequence++;
  }

  function formatSSE(ev: ResponsesStreamEvent): string {
    return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  }

  function emitInitial(): string {
    if (sentInitial) return "";
    sentInitial = true;
    let out = "";
    out += formatSSE({
      type: "response.created",
      sequence_number: nextSeq(),
      response: cloneSnapshot(),
    });
    out += formatSSE({
      type: "response.in_progress",
      sequence_number: nextSeq(),
      response: cloneSnapshot(),
    });
    return out;
  }

  function cloneSnapshot(): ResponsesResponse {
    // Defensive: the consumer caches by reference in some clients.
    return {
      ...responseSnapshot,
      output: responseSnapshot.output.slice(),
      usage: responseSnapshot.usage ? { ...responseSnapshot.usage } : undefined,
    };
  }

  function openTextBlock(): { intro: string; block: Extract<OpenBlock, { kind: "text" }> } {
    outputIndex++;
    const itemId = `msg_${responseId}_${outputIndex}`;
    const block: Extract<OpenBlock, { kind: "text" }> = {
      kind: "text",
      outputIndex,
      itemId,
      contentIndex: 0,
      accumulated: "",
    };

    const item: ResponsesOutputItem = {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [],
    };
    // Snapshot mutation: reflect the new in-flight item.
    responseSnapshot.output.push(item);

    let intro = "";
    intro += formatSSE({
      type: "response.output_item.added",
      sequence_number: nextSeq(),
      output_index: outputIndex,
      item,
    });
    intro += formatSSE({
      type: "response.content_part.added",
      sequence_number: nextSeq(),
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    return { intro, block };
  }

  function closeBlock(): string {
    if (!open) return "";
    let out = "";
    if (open.kind === "text") {
      out += formatSSE({
        type: "response.content_part.done",
        sequence_number: nextSeq(),
        output_index: open.outputIndex,
        content_index: open.contentIndex,
        part: { type: "output_text", text: open.accumulated },
      });
      const idx = open.outputIndex;
      const finalItem: ResponsesOutputItem = {
        id: open.itemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: open.accumulated }],
      };
      responseSnapshot.output[idx] = finalItem;
      out += formatSSE({
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: idx,
        item: finalItem,
      });
    } else {
      out += formatSSE({
        type: "response.function_call_arguments.done",
        sequence_number: nextSeq(),
        output_index: open.outputIndex,
        arguments: open.accumulatedArgs,
      });
      const idx = open.outputIndex;
      const finalItem: ResponsesOutputItem = {
        id: open.itemId,
        type: "function_call",
        call_id: open.callId,
        name: open.name,
        arguments: open.accumulatedArgs,
        status: "completed",
      };
      responseSnapshot.output[idx] = finalItem;
      out += formatSSE({
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: idx,
        item: finalItem,
      });
      toolBlocksByIndex.delete(open.outputIndex);
    }
    open = null;
    return out;
  }

  function emitCompletion(): string {
    let out = "";
    out += closeBlock();
    responseSnapshot.status = "completed";
    if (usage) {
      responseSnapshot.usage = usage;
    }
    out += formatSSE({
      type: "response.completed",
      sequence_number: nextSeq(),
      response: cloneSnapshot(),
    });
    completed = true;
    return out;
  }

  function emitFailure(message: string): string {
    let out = closeBlock();
    responseSnapshot.status = "failed";
    responseSnapshot.error = { code: "server_error", message };
    out += formatSSE({
      type: "response.failed",
      sequence_number: nextSeq(),
      response: cloneSnapshot(),
    });
    completed = true;
    return out;
  }

  function handleTextDelta(text: string): string {
    if (!text) return "";
    let out = "";
    if (open?.kind !== "text") {
      if (open) out += closeBlock();
      const { intro, block } = openTextBlock();
      out += intro;
      open = block;
    }
    open.accumulated += text;
    out += formatSSE({
      type: "response.output_text.delta",
      sequence_number: nextSeq(),
      output_index: open.outputIndex,
      content_index: open.contentIndex,
      delta: text,
    });
    return out;
  }

  function handleToolCallDelta(
    index: number,
    delta: { id?: string; function?: { name?: string; arguments?: string } },
  ): string {
    let out = "";
    let block = toolBlocksByIndex.get(index) ?? null;

    if (!block) {
      // First chunk for this tool call → open a new function_call item.
      // Close any previously open block first (Codex CLI requires items to
      // close before the next one opens).
      if (open && open.kind !== "tool") {
        out += closeBlock();
      } else if (open?.kind === "tool" && open.outputIndex !== -1) {
        // A different tool call is already open — close it before starting
        // the new one. (Copilot streams tool calls one at a time today, but
        // be defensive.)
        out += closeBlock();
      }
      outputIndex++;
      const itemId = `fc_${responseId}_${outputIndex}`;
      const callId = delta.id || `call_${Date.now()}_${index}`;
      const name = delta.function?.name ?? "";

      block = {
        kind: "tool",
        outputIndex,
        itemId,
        callId,
        name,
        accumulatedArgs: "",
      };
      open = block;
      toolBlocksByIndex.set(index, block);

      const item: ResponsesOutputItem = {
        id: itemId,
        type: "function_call",
        call_id: callId,
        name,
        arguments: "",
        status: "completed",
      };
      responseSnapshot.output.push(item);

      out += formatSSE({
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: outputIndex,
        item,
      });
    } else if (open !== block) {
      // The matching block exists but isn't currently the "open" cursor —
      // close whatever's on top first so output items don't interleave.
      if (open) out += closeBlock();
      open = block;
    }

    // Keep the snapshot's name up-to-date if the model streamed the name in
    // a later chunk (rare, but the OpenAI spec allows it).
    if (delta.function?.name && !block.name) {
      block.name = delta.function.name;
      const item = responseSnapshot.output[block.outputIndex];
      if (item && item.type === "function_call") {
        item.name = block.name;
      }
    }

    if (delta.function?.arguments) {
      block.accumulatedArgs += delta.function.arguments;
      out += formatSSE({
        type: "response.function_call_arguments.delta",
        sequence_number: nextSeq(),
        output_index: block.outputIndex,
        delta: delta.function.arguments,
      });
    }

    return out;
  }

  // Buffer to collect raw SSE text, then parse synchronously per transform call
  let sseBuffer = "";

  function processSSEBuffer(controller: TransformStreamDefaultController<string>): void {
    while (true) {
      const frameEnd = sseBuffer.indexOf("\n\n");
      if (frameEnd === -1) break;
      const frame = sseBuffer.slice(0, frameEnd).trim();
      sseBuffer = sseBuffer.slice(frameEnd + 2);
      if (!frame) continue;

      const lines = frame.split("\n");
      let data = "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          data += line.slice(6);
        } else if (line.startsWith("data:")) {
          data += line.slice(5);
        }
      }
      if (!data) continue;

      if (data === "[DONE]") {
        if (!completed) {
          let out = "";
          if (!sentInitial) out += emitInitial();
          if (!messageStarted) {
            // No deltas at all — emit an empty text block so Codex doesn't
            // see a completely-empty response (some clients tolerate it,
            // some don't; the empty placeholder matches what the
            // non-streaming converter would emit).
            const { intro, block } = openTextBlock();
            out += intro;
            open = block;
            messageStarted = true;
          }
          // Surface the model's stop reason in the snapshot for callers
          // that inspect it; Responses doesn't carry a top-level finish
          // reason, but we keep the local for parity.
          void finishReason;
          out += emitCompletion();
          if (out) controller.enqueue(out);
        }
        return;
      }

      try {
        const chunk = JSON.parse(data) as {
          choices?: CopilotStreamChoice[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };

        let out = "";
        if (!sentInitial) out += emitInitial();

        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens ?? 0,
            output_tokens: chunk.usage.completion_tokens ?? 0,
            total_tokens: chunk.usage.total_tokens,
          };
        }

        const choice = chunk.choices?.[0];
        if (choice) {
          if (choice.delta.content != null && choice.delta.content !== "") {
            messageStarted = true;
            out += handleTextDelta(choice.delta.content);
          }
          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              messageStarted = true;
              out += handleToolCallDelta(tc.index, {
                id: tc.id,
                function: tc.function,
              });
            }
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }

        if (out) controller.enqueue(out);
      } catch {
        // Skip malformed chunks (matches Claude transformer semantics).
      }
    }
  }

  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      if (completed) return;
      sseBuffer += new TextDecoder().decode(chunk);
      processSSEBuffer(controller);
    },
    flush(controller) {
      if (completed) return;
      // Drain any straggler frame missing its trailing blank line.
      if (sseBuffer.trim()) {
        sseBuffer += "\n\n";
        processSSEBuffer(controller);
      }
      if (!completed) {
        let out = "";
        if (!sentInitial) out += emitInitial();
        if (!messageStarted) {
          const { intro, block } = openTextBlock();
          out += intro;
          open = block;
        }
        out += emitCompletion();
        if (out) controller.enqueue(out);
      }
    },
  });
}

/**
 * Build a single `response.failed` SSE frame for use when the upstream
 * Copilot request errors before any chunks were transformed. Exported so
 * the route handler can fall back to a Responses-style failure event when
 * `chatCompletionStream` itself throws.
 */
export function buildResponsesFailureSSE(
  originalModel: string,
  message: string,
): string {
  const responseId = `resp_${Date.now()}`;
  const snapshot: ResponsesResponse = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "failed",
    model: originalModel,
    output: [],
    error: { code: "server_error", message },
    conversation_id: null,
  };
  let seq = 0;
  const created: ResponsesStreamEvent = {
    type: "response.created",
    sequence_number: seq++,
    response: { ...snapshot, status: "in_progress", error: null },
  };
  const failed: ResponsesStreamEvent = {
    type: "response.failed",
    sequence_number: seq++,
    response: snapshot,
  };
  return (
    `event: ${created.type}\ndata: ${JSON.stringify(created)}\n\n` +
    `event: ${failed.type}\ndata: ${JSON.stringify(failed)}\n\n`
  );
}
