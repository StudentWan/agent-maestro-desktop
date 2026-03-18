import { Hono } from "hono";

/**
 * GET /health - Health check endpoint
 */
export function registerHealthRoutes(app: Hono) {
  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: Date.now() });
  });
}
