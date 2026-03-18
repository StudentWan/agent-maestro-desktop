import type { CopilotTool } from "../copilot/types";

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
}

/**
 * Convert Anthropic tool definitions to OpenAI/Copilot function tool format
 */
export function convertToolsToOpenAI(tools?: AnthropicTool[]): CopilotTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools
    .filter((tool) => {
      // Skip built-in Anthropic tool types that don't translate
      if (tool.type && !tool.input_schema && tool.type !== "custom") {
        return false;
      }
      return true;
    })
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
}

/**
 * Convert Anthropic tool_choice to OpenAI format
 */
export function convertToolChoiceToOpenAI(
  toolChoice?: { type: string; name?: string },
): string | { type: string; function?: { name: string } } | undefined {
  if (!toolChoice) return undefined;

  switch (toolChoice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return {
        type: "function",
        function: { name: toolChoice.name || "" },
      };
    default:
      return "auto";
  }
}
