import type { Context, Next } from "hono";
import { truncateUpstreamBody } from "../../copilot/upstream-error";
import type { RequestLogEntry, UpstreamErrorInfo } from "../../shared/types";

type LogCallback = (entry: RequestLogEntry) => void;

/**
 * Per-request metadata that route handlers stash on the Hono context for the
 * request-logger middleware to pick up after the response is finalized.
 *
 * Declared as a module augmentation so `c.set("loggedModel", ...)` and
 * `c.get("loggedModel")` are properly typed everywhere in the proxy.
 */
declare module "hono" {
  interface ContextVariableMap {
    loggedModel: string;
    loggedStream: boolean;
    loggedInputTokens: number;
    loggedOutputTokens: number;
    loggedThinkingLevel: string;
    loggedError: string;
    loggedUpstreamError: UpstreamErrorInfo;
  }
}

let requestCounter = 0;

/**
 * Create request logging middleware.
 *
 * The route handler is responsible for stashing per-request metadata onto
 * the Hono context BEFORE its response is finalized:
 *
 *   c.set("loggedModel", "claude-sonnet-4");
 *   c.set("loggedStream", true);
 *   c.set("loggedInputTokens", 123);
 *   c.set("loggedOutputTokens", 456);
 *   c.set("loggedError", "optional error message");
 *   c.set("loggedUpstreamError", { status: 502, body: "<raw body>" });
 *
 * Why context-stash instead of re-reading the body? The route already calls
 * `await c.req.json()` which consumes the request stream — it can't be read
 * twice. Passing values through `c.set/c.get` avoids that and keeps the
 * logger free of route-specific JSON parsing.
 */
export function createRequestLogger(onLog: LogCallback) {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    const id = `req_${++requestCounter}`;

    await next();

    const duration = Date.now() - start;

    if (c.req.method === "HEAD" && c.req.path === "/") {
      return;
    }

    const model = c.get("loggedModel") ?? formatRequestLabel(c.req.method, c.req.path);
    const stream =
      c.get("loggedStream") ??
      (c.req.header("accept")?.includes("text/event-stream") ?? false);
    const inputTokens = c.get("loggedInputTokens");
    const outputTokens = c.get("loggedOutputTokens");
    const thinkingLevel = c.get("loggedThinkingLevel");
    const upstreamError = c.get("loggedUpstreamError");
    let error = c.get("loggedError");
    if (!error && !upstreamError && c.res.status >= 400) {
      error = await readErrorResponseBody(c.res);
    }

    const entry: RequestLogEntry = {
      id,
      timestamp: start,
      method: c.req.method,
      path: c.req.path,
      model,
      status: c.res.status,
      durationMs: duration,
      stream,
      inputTokens,
      outputTokens,
      thinkingLevel,
      error,
      upstreamError,
    };

    onLog(entry);
  };
}

function formatRequestLabel(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

async function readErrorResponseBody(response: Response): Promise<string> {
  try {
    const body = await response.clone().text();
    if (body.length > 0) {
      return truncateUpstreamBody(body);
    }
  } catch {
    // Some response bodies (especially streams) may not be cloneable/readable.
    // The log row should still be expandable with the status we know.
  }

  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return `HTTP ${response.status}${statusText}`;
}
