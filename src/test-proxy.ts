/**
 * Standalone test script that starts only the proxy server
 * (without Electron) for testing endpoints.
 *
 * Usage: npx tsx src/test-proxy.ts
 */
import { ProxyServer } from "./proxy/server";

const port = 23337;
const server = new ProxyServer(port);

server.setLogCallback((entry) => {
  console.log(`[LOG] ${entry.method} ${entry.path} → ${entry.status} (${entry.durationMs}ms)`);
});

server.start().then(() => {
  console.log(`\nProxy server running on http://127.0.0.1:${port}`);
  console.log("No auth configured — /v1/messages will return 401");
  console.log("\nTest endpoints:");
  console.log(`  curl http://127.0.0.1:${port}/health`);
  console.log(`  curl http://127.0.0.1:${port}/v1/models`);
  console.log(`  curl -X POST http://127.0.0.1:${port}/v1/messages/count_tokens -H "Content-Type: application/json" -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"test"}],"max_tokens":100}'`);
  console.log(`  curl -X POST http://127.0.0.1:${port}/v1/messages -H "Content-Type: application/json" -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}],"max_tokens":100}'`);
  console.log("\nPress Ctrl+C to stop.");
});
