import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { __testing } from "../local-config";

const { parseExisting, mergeProvider, stripProvider, PROVIDER_NAME } =
  __testing;

describe("Codex local-config (parse → merge → stringify)", () => {
  it("merges our provider into a fresh config", () => {
    const merged = mergeProvider({}, 23337, "gpt-5");
    expect(merged.model).toBe("gpt-5");
    expect(merged.model_provider).toBe(PROVIDER_NAME);
    expect(merged.model_providers?.[PROVIDER_NAME]).toEqual({
      name: "Agent Maestro Desktop",
      base_url: "http://127.0.0.1:23337/codex/v1",
      wire_api: "responses",
      request_timeout: 600,
    });
  });

  it("preserves user-authored [mcp_servers.*] and other providers", () => {
    const userToml = `
model = "gpt-4o"

[mcp_servers.local]
command = "node"
args = ["server.js"]

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
wire_api = "chat"
`;
    const existing = parseExisting(userToml);
    const merged = mergeProvider(existing, 23337, "gpt-5");

    // Our keys are present.
    expect(merged.model_provider).toBe(PROVIDER_NAME);
    expect(merged.model_providers?.[PROVIDER_NAME]).toBeDefined();
    // Our model overrides the user's model.
    expect(merged.model).toBe("gpt-5");
    // User content preserved verbatim.
    expect(merged.mcp_servers).toEqual({
      local: { command: "node", args: ["server.js"] },
    });
    expect(merged.model_providers?.openai).toEqual({
      name: "OpenAI",
      base_url: "https://api.openai.com/v1",
      wire_api: "chat",
    });
  });

  it("does not overwrite an existing model when no modelId is supplied", () => {
    const existing = parseExisting(`model = "gpt-4o"\n`);
    const merged = mergeProvider(existing, 23337, null);
    expect(merged.model).toBe("gpt-4o");
    expect(merged.model_provider).toBe(PROVIDER_NAME);
  });

  it("stripProvider drops only our keys, leaves user content untouched", () => {
    const merged = mergeProvider(
      parseExisting(
        `[mcp_servers.local]\ncommand = "node"\n\n[model_providers.openai]\nname = "OpenAI"\n`,
      ),
      23337,
      "gpt-5",
    );
    const stripped = stripProvider(merged);
    expect(stripped).not.toBeNull();
    expect(stripped!.model_provider).toBeUndefined();
    expect(stripped!.model_providers?.[PROVIDER_NAME]).toBeUndefined();
    expect(stripped!.model_providers?.openai).toBeDefined();
    expect(stripped!.mcp_servers).toEqual({
      local: { command: "node" },
    });
    // `model` is intentionally not removed — we can't tell whether the user
    // set it or we did. Upstream Joouis/agent-maestro behaves the same way.
    expect(stripped!.model).toBe("gpt-5");
  });

  it("stripProvider returns null when removing leaves nothing behind", () => {
    const merged = mergeProvider({}, 23337, null);
    const stripped = stripProvider(merged);
    // Only our keys → null so the caller can truncate the file.
    expect(stripped).toBeNull();
  });

  it("stripProvider preserves `model_providers` when other providers remain", () => {
    const merged = mergeProvider(
      parseExisting(
        `[model_providers.openai]\nname = "OpenAI"\nbase_url = "https://api.openai.com/v1"\n`,
      ),
      23337,
      null,
    );
    const stripped = stripProvider(merged);
    expect(stripped!.model_providers).toEqual({
      openai: {
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
      },
    });
  });

  it("does not crash on an unparseable existing file (starts fresh)", () => {
    // Unclosed quote — smol-toml will throw.
    const broken = `model = "unclosed\n[broken section\n`;
    const parsed = parseExisting(broken);
    expect(parsed).toEqual({});
  });

  it("re-parsing our stringified output preserves all keys (roundtrip)", () => {
    const userToml = `
[mcp_servers.local]
command = "node"
args = ["server.js"]
env = { NODE_ENV = "dev" }
`;
    const { stringify } = require("smol-toml") as typeof import("smol-toml");
    const merged = mergeProvider(parseExisting(userToml), 23337, "gpt-5");
    const reparsed = parse(stringify(merged));
    // Roundtrip preserves both our keys and the user's nested env table.
    expect(reparsed.model_provider).toBe(PROVIDER_NAME);
    expect(
      (reparsed.mcp_servers as Record<string, Record<string, unknown>>).local
        .command,
    ).toBe("node");
    expect(
      (reparsed.mcp_servers as Record<string, Record<string, unknown>>).local
        .env,
    ).toEqual({ NODE_ENV: "dev" });
  });
});
