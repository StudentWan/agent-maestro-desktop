/**
 * Codex-side HTTP client for Copilot's native OpenAI Responses endpoint.
 *
 * Why a separate client (instead of going through the generic
 * CopilotClient or the Codex converter):
 *
 *   - Newer reasoning-capable models (gpt-5.5 and friends) are routed by
 *     Copilot ONLY via `/responses`. Posting them to `/chat/completions`
 *     yields HTTP 400 with `unsupported_api_for_model` ("model is not
 *     accessible via the /chat/completions endpoint"). Translating
 *     Responses → ChatCompletions therefore breaks for exactly the model
 *     family Codex CLI is most useful with.
 *   - Responses semantics (output_item.added, function_call, reasoning
 *     summary, sequence_number) are richer than ChatCompletions. Round-
 *     tripping them through ChatCompletions loses information; passing the
 *     bytes through unchanged preserves everything Codex CLI relies on.
 *
 * So this client does the boring thing: take the body Codex CLI sent us,
 * forward it verbatim to `${baseUrl}/responses` with Copilot auth headers,
 * and stream the response back. The Codex route handler is a thin shim on
 * top of this — no schema validation, no body rewriting (beyond the few
 * unsupported parameters we strip up front in the route).
 *
 * Lives in src/agents/codex/ (not src/copilot/) so the boundary contract
 * holds: Codex-specific networking stays Codex-specific. The generic
 * Copilot client knows nothing about Responses.
 */
import type { TokenManager } from "../../copilot/token-manager";
import {
  buildCopilotHeaders,
  buildCopilotStreamHeaders,
} from "../../copilot/headers";
import { CopilotUpstreamError, truncateUpstreamBody } from "../../copilot/upstream-error";

/** Resolve `${baseUrl}/responses`, normalising any trailing `/v1` segment. */
function resolveResponsesUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  // Copilot's base ends without /v1 in production, but tolerate either.
  return normalized.endsWith("/v1")
    ? `${normalized}/responses`
    : `${normalized}/responses`;
}

/**
 * Body fields we strip before forwarding. Two categories share this list:
 *
 *  - State-carrying parameters Copilot's `/responses` validator rejects
 *    because the proxy is stateless (`previous_response_id`, `conversation`).
 *    The route handler also rejects these up front with a 400; the strip
 *    here is belt-and-braces.
 *
 *  - OpenAI-only metadata Copilot silently ignores: cache hints, billing
 *    tier, user/safety identifiers, optional `prompt` template, opaque
 *    `metadata` bag, `store`/`background`/`include` (all assume a stateful
 *    Responses store, which Copilot is not). Removing them shrinks long-
 *    session payloads enough to dodge upstream 413 Payload Too Large at
 *    the margin — matches what Joouis's VS Code-extension version does.
 */
const STRIPPED_BODY_FIELDS = [
  "previous_response_id",
  "conversation",
  "store",
  "include",
  "background",
  "prompt",
  "prompt_cache_key",
  "service_tier",
  "user",
  "safety_identifier",
  "metadata",
] as const;

function sanitizeBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const obj = body as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if ((STRIPPED_BODY_FIELDS as readonly string[]).includes(key)) {
      changed = true;
      continue;
    }
    out[key] = value;
  }
  return changed ? out : body;
}

export class CopilotResponsesClient {
  constructor(private readonly tokenManager: TokenManager) {}

  /**
   * Forward a non-streaming Responses request. Returns the parsed JSON
   * body unchanged from Copilot.
   */
  async createResponse(body: unknown): Promise<unknown> {
    const tokenBundle = await this.tokenManager.getTokenBundle();
    const headers = buildCopilotHeaders(tokenBundle.token);
    const response = await fetch(resolveResponsesUrl(tokenBundle.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ ...(sanitizeBody(body) as object), stream: false }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new CopilotUpstreamError(
        `Copilot Responses API error (${response.status})`,
        response.status,
        truncateUpstreamBody(text),
      );
    }
    return response.json();
  }

  /**
   * Forward a streaming Responses request. The caller is responsible for
   * piping `response.body` back to the client unchanged — we already speak
   * SSE, no transformation needed.
   */
  async createResponseStream(body: unknown): Promise<Response> {
    const tokenBundle = await this.tokenManager.getTokenBundle();
    const headers = buildCopilotStreamHeaders(tokenBundle.token);
    const response = await fetch(resolveResponsesUrl(tokenBundle.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ ...(sanitizeBody(body) as object), stream: true }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new CopilotUpstreamError(
        `Copilot Responses API stream error (${response.status})`,
        response.status,
        truncateUpstreamBody(text),
      );
    }

    return response;
  }
}
