import type { Context, Next } from "hono";
import type { RequestLogEntry } from "../../shared/types";

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

    const model = c.get("loggedModel") ?? "unknown";
    const stream =
      c.get("loggedStream") ??
      (c.req.header("accept")?.includes("text/event-stream") ?? false);
    const inputTokens = c.get("loggedInputTokens");
    const outputTokens = c.get("loggedOutputTokens");
    const thinkingLevel = c.get("loggedThinkingLevel");
    const error = c.get("loggedError");

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
    };

    onLog(entry);
  };
}
