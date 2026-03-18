// Anthropic model → Copilot model mapping
const MODEL_MAP: Record<string, string> = {
  // Haiku → mini
  "claude-haiku-4-5-20251001": "gpt-4o-mini",
  "claude-3-5-haiku-20241022": "gpt-4o-mini",
  "claude-3-haiku-20240307": "gpt-4o-mini",
  // Everything else → gpt-4.1
};

const HAIKU_PATTERNS = [/haiku/i];

/**
 * Map an Anthropic model name to a Copilot-compatible model name
 */
export function mapModelName(anthropicModel: string): string {
  // Direct mapping
  if (MODEL_MAP[anthropicModel]) {
    return MODEL_MAP[anthropicModel];
  }

  // Pattern-based mapping for haiku variants
  for (const pattern of HAIKU_PATTERNS) {
    if (pattern.test(anthropicModel)) {
      return "gpt-4o-mini";
    }
  }

  // Default: use gpt-4.1 for all Claude models
  return "gpt-4.1";
}

/**
 * Get the max tokens for a mapped model
 */
export function getModelMaxTokens(copilotModel: string): number {
  switch (copilotModel) {
    case "gpt-4o-mini":
      return 16384;
    case "gpt-4.1":
      return 32768;
    default:
      return 16384;
  }
}
