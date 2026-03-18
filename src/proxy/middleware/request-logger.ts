import type { Context, Next } from "hono";
import type { RequestLogEntry } from "../../shared/types";

type LogCallback = (entry: RequestLogEntry) => void;

let requestCounter = 0;

/**
 * Create request logging middleware
 */
export function createRequestLogger(onLog: LogCallback) {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    const id = `req_${++requestCounter}`;

    await next();

    const duration = Date.now() - start;

    // Read model/stream/tokens from response headers or just log basics
    const entry: RequestLogEntry = {
      id,
      timestamp: start,
      method: c.req.method,
      path: c.req.path,
      model: "unknown",
      status: c.res.status,
      durationMs: duration,
      stream: c.req.header("accept")?.includes("text/event-stream") ?? false,
    };

    onLog(entry);
  };
}
