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

/** Resolve `${baseUrl}/responses`, normalising any trailing `/v1` segment. */
function resolveResponsesUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  // Copilot's base ends without /v1 in production, but tolerate either.
  return normalized.endsWith("/v1")
    ? `${normalized}/responses`
    : `${normalized}/responses`;
}

/**
 * Body fields we strip before forwarding. Copilot's /responses validator
 * rejects state-carrying parameters because the proxy is stateless; let's
 * be the one that says "no" instead of relaying upstream's terse 400.
 *
 * The route handler also rejects `previous_response_id` / `conversation`
 * with a 400 *before* we get here — the strip below is a belt-and-braces
 * guard for any future client that finds another way to add them.
 */
const STRIPPED_BODY_FIELDS = ["previous_response_id", "conversation"] as const;

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
      throw new Error(
        `Copilot Responses API error (${response.status}): ${text}`,
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
      throw new Error(
        `Copilot Responses API stream error (${response.status}): ${text}`,
      );
    }

    return response;
  }
}
