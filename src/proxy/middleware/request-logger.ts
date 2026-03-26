import type { Context, Next } from "hono";
import type { RequestLogEntry } from "../../shared/types";

type LogCallback = (entry: RequestLogEntry) => void;

let requestCounter = 0;

/** Paths to exclude from request logging (noisy health checks, etc.) */
const EXCLUDED_PATHS = new Set(["/health"]);

/**
 * Detect whether a request originates from a codespace (via SSH reverse tunnel)
 * or from a local Claude Code instance.
 *
 * SSH reverse tunnels set the source address to the SSH daemon's loopback.
 * We use the X-Forwarded-For header as a hint, and also check if the request
 * carries our custom header set by the remote config script.
 *
 * Heuristic: if the request has no X-Forwarded-For and comes from 127.0.0.1,
 * we check for a marker header. Without it, we fall back to checking the port.
 */
function detectSource(c: Context, tunnelPorts: ReadonlySet<number>): "local" | "codespace" {
  // Check custom header that could be set by codespace config
  const maestroSource = c.req.header("x-agent-maestro-source");
  if (maestroSource === "codespace") return "codespace";

  // Check if the request arrived on a port that we know is a tunnel remote port.
  // In Hono on Node, the URL contains the host:port the server is listening on.
  // Since all requests arrive on the same proxy port, we can't distinguish by port alone.
  // Instead, we'll check the raw request URL for any hints.

  // Fallback: check X-Forwarded-For which SSH tunnels may set
  const xff = c.req.header("x-forwarded-for");
  if (xff) return "codespace";

  return "local";
}

/**
 * Create request logging middleware.
 *
 * @param onLog - Callback invoked with each log entry
 * @param tunnelPorts - Set of remote ports used by SSH tunnels (for source detection)
 */
export function createRequestLogger(
  onLog: LogCallback,
  tunnelPorts?: ReadonlySet<number>,
) {
  const ports = tunnelPorts ?? new Set<number>();

  return async (c: Context, next: Next) => {
    // Skip noisy endpoints
    if (EXCLUDED_PATHS.has(c.req.path)) {
      await next();
      return;
    }

    const start = Date.now();
    const id = `req_${++requestCounter}`;

    // Try to extract model from request body (before next() consumes it).
    // Clone the request to avoid consuming the body.
    let model = "unknown";
    if (c.req.method === "POST" && c.req.path.includes("/messages")) {
      try {
        const cloned = c.req.raw.clone();
        const body = (await cloned.json()) as { model?: string };
        if (body.model) {
          model = body.model;
        }
      } catch {
        // Body parsing failed — keep "unknown"
      }
    }

    const source = detectSource(c, ports);

    await next();

    const duration = Date.now() - start;

    const entry: RequestLogEntry = {
      id,
      timestamp: start,
      method: c.req.method,
      path: c.req.path,
      model,
      status: c.res.status,
      durationMs: duration,
      stream: c.req.header("accept")?.includes("text/event-stream") ?? false,
      source,
    };

    onLog(entry);
  };
}
