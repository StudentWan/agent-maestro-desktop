import { Hono } from "hono";

/**
 * Health check endpoints
 */
export function registerHealthRoutes(app: Hono) {
  app.all("/", (c) => {
    if (c.req.method !== "HEAD") {
      return c.notFound();
    }

    return new Response(null, { status: 204 });
  });

  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: Date.now() });
  });
}
