/**
 * Carries the upstream HTTP status + raw response body across the
 * client/route/middleware boundary so the request-logger can surface them
 * to the renderer without re-parsing a flattened Error message string.
 *
 * Thrown from every Copilot fetch site that hits `!response.ok`; caught in
 * the route handlers, which stash the structured payload on the Hono
 * context via `c.set("loggedUpstreamError", ...)`.
 */
export class CopilotUpstreamError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(`${message}: ${body}`);
    this.name = "CopilotUpstreamError";
    this.status = status;
    this.body = body;
  }
}

const MAX_BODY_CHARS = 16 * 1024;

/**
 * Cap the body before it crosses IPC. Upstream error responses can be
 * surprising in size (full HTML error pages from load balancers, long
 * stack-traces) — 16 KB is enough to diagnose the typical failures (auth,
 * context_length, upstream JSON errors) without bloating the renderer's
 * in-memory log buffer.
 */
export function truncateUpstreamBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) {
    return body;
  }
  const dropped = body.length - MAX_BODY_CHARS;
  return `${body.slice(0, MAX_BODY_CHARS)}\n... [truncated ${dropped} chars]`;
}
