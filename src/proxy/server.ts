import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { CopilotClient } from "../copilot/client";
import type { AgentPlugin } from "../agents/types";
import type { RequestLogEntry } from "../shared/types";
import { createRequestLogger } from "./middleware/request-logger";
import { registerHealthRoutes } from "./routes/health";

/**
 * Plugin-driven proxy server.
 *
 * The Hono app + request logger + /health route are agent-agnostic.
 * Everything else — Anthropic Messages, Codex Responses, model lists, ... —
 * comes from the per-agent plugins passed in at construction time. The
 * server itself never imports anything from `src/agents/<name>/...`,
 * which is what mechanically keeps the per-agent boundary honest.
 */
export class ProxyServer {
  private app: Hono;
  private server: ServerType | null = null;
  private port: number;
  private copilotClient: CopilotClient | null = null;
  private onLogCallback?: (entry: RequestLogEntry) => void;
  private requestCount = 0;
  private readonly plugins: readonly AgentPlugin[];

  constructor(port: number, plugins: readonly AgentPlugin[]) {
    this.port = port;
    this.plugins = plugins;
    this.app = new Hono();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Set the log callback for request logging
   */
  setLogCallback(cb: (entry: RequestLogEntry) => void): void {
    this.onLogCallback = cb;
  }

  /**
   * Set the Copilot client (called after authentication)
   */
  setCopilotClient(client: CopilotClient | null): void {
    this.copilotClient = client;
  }

  /**
   * Start the proxy server
   */
  async start(): Promise<void> {
    if (this.server) {
      console.log("[ProxyServer] Already running");
      return;
    }

    this.server = serve({
      fetch: this.app.fetch,
      port: this.port,
      hostname: "127.0.0.1",
    });

    console.log(
      `[ProxyServer] Started on http://127.0.0.1:${this.port} ` +
        `(agents: ${this.plugins.map((p) => p.id).join(", ")})`,
    );
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log("[ProxyServer] Stopped");
    }
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Get the port
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get request count
   */
  getRequestCount(): number {
    return this.requestCount;
  }

  private setupMiddleware(): void {
    this.app.use(cors());

    // Request logging
    this.app.use("*", createRequestLogger((entry) => {
      this.requestCount++;
      this.onLogCallback?.(entry);
    }));
  }

  private setupRoutes(): void {
    // Cross-agent
    registerHealthRoutes(this.app);

    // Per-agent: each plugin owns its routes (model list, request handling).
    for (const plugin of this.plugins) {
      plugin.registerRoutes(this.app, () => this.copilotClient);
    }
  }
}
