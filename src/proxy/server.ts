import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { CopilotClient } from "../copilot/client";
import type { RequestLogEntry } from "../shared/types";
import { createRequestLogger } from "./middleware/request-logger";
import { registerHealthRoutes } from "./routes/health";
import { registerModelsRoutes } from "./routes/models";
import { registerMessagesRoute } from "./routes/anthropic-messages";
import { registerCountTokensRoute } from "./routes/anthropic-count-tokens";

export class ProxyServer {
  private app: Hono;
  private server: ServerType | null = null;
  private port: number;
  private copilotClient: CopilotClient | null = null;
  private onLogCallback?: (entry: RequestLogEntry) => void;
  private requestCount = 0;

  constructor(port: number) {
    this.port = port;
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

    console.log(`[ProxyServer] Started on http://127.0.0.1:${this.port}`);
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
    // Health check
    registerHealthRoutes(this.app);

    // Models list
    registerModelsRoutes(this.app);

    // Anthropic Messages API
    registerMessagesRoute(this.app, () => this.copilotClient);

    // Token counting
    registerCountTokensRoute(this.app);
  }
}
