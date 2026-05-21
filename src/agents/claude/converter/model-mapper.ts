/**
 * Map Anthropic model IDs to Copilot-compatible model IDs.
 *
 * Anthropic uses hyphens in version numbers (e.g. claude-sonnet-4-6)
 * while Copilot uses dots (e.g. claude-sonnet-4.6).
 * Anthropic also appends date suffixes (e.g. -20251001) which Copilot omits.
 */

// Explicit mappings for known models
const MODEL_MAP: Record<string, string> = {
  // Opus
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-6-1m": "claude-opus-4.6-1m",
  "claude-opus-4-5": "claude-opus-4.5",
  // Sonnet
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-sonnet-4-6-1m": "claude-sonnet-4.6-1m",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  // Haiku
  "claude-haiku-4-5-20251001": "claude-haiku-4.5",
  "claude-3-5-haiku-20241022": "claude-haiku-4.5",
  "claude-3-haiku-20240307": "claude-haiku-4.5",
};

/**
 * Convert an Anthropic model ID to a Copilot-compatible model ID.
 *
 * 1. Exact match from known mapping table
 * 2. Pattern-based conversion: strip date suffix, convert last hyphen-separated
 *    version digits to dot notation (e.g. claude-opus-4-6 → claude-opus-4.6)
 * 3. Passthrough as-is if no conversion rule matches
 */
export function mapModelName(anthropicModel: string): string {
  // 1. Direct lookup
  if (MODEL_MAP[anthropicModel]) {
    return MODEL_MAP[anthropicModel];
  }

  // 2. Pattern: strip trailing date suffix (-YYYYMMDD) and convert version
  //    e.g. "claude-sonnet-4-6-20260101" → "claude-sonnet-4.6"
  const withoutDate = anthropicModel.replace(/-\d{8}$/, "");
  if (MODEL_MAP[withoutDate]) {
    return MODEL_MAP[withoutDate];
  }

  // 3. Generic pattern: "claude-<family>-<major>-<minor>[-1m]" → "claude-<family>-<major>.<minor>[-1m]"
  const match = withoutDate.match(/^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d+)(?:-(1m))?$/);
  if (match) {
    const suffix = match[4] ? `-${match[4]}` : "";
    return `${match[1]}-${match[2]}.${match[3]}${suffix}`;
  }

  // 4. Passthrough
  return anthropicModel;
}
