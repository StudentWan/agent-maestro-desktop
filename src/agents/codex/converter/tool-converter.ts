import type { CopilotTool } from "../../../copilot/types";
import type { ResponsesTool, ResponsesToolChoice } from "./types";

/**
 * Convert OpenAI Responses-API tool definitions to the OpenAI
 * ChatCompletions tool shape that Copilot accepts.
 *
 * Codex CLI only ever sends `type: "function"` tools — the Responses
 * "computer_use" / "file_search" / "web_search_preview" built-ins don't
 * apply to a generic coding agent. Anything that isn't a function tool we
 * silently drop rather than fail the request, mirroring Claude's
 * permissive tool conversion (`stripUnsupportedCopilotTools`).
 */
export function convertResponsesToolsToOpenAI(
  tools?: ResponsesTool[],
): CopilotTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const out: CopilotTool[] = [];
  for (const tool of tools) {
    if (tool.type !== "function") continue;
    if (!tool.name) continue;
    out.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} },
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Convert Responses `tool_choice` to the ChatCompletions form.
 * Responses "auto" | "none" | "required" map 1:1; the named-function form
 * `{type:"function", name}` becomes `{type:"function", function:{name}}`.
 */
export function convertResponsesToolChoiceToOpenAI(
  toolChoice?: ResponsesToolChoice,
): string | { type: string; function?: { name: string } } | undefined {
  if (toolChoice === undefined) return undefined;

  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "auto":
      case "none":
      case "required":
        return toolChoice;
      default:
        return undefined;
    }
  }

  if (toolChoice && toolChoice.type === "function" && toolChoice.name) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return undefined;
}
