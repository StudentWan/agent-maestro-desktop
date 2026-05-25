import { describe, expect, it } from "vitest";
import { __testing } from "../local-config";

const { spliceManagedBlock, renderManagedBlock, MARKER_BEGIN, MARKER_END } =
  __testing;

describe("Codex local-config splicer", () => {
  it("prepends a fresh block above user-authored TOML without touching it", () => {
    const userToml = `# my codex config
model = "gpt-4o"

[mcp_servers.local]
command = "node"
args = ["server.js"]
`;
    const block = renderManagedBlock({ port: 23337, modelId: "gpt-5" });
    const out = spliceManagedBlock(userToml, block);
    // Original user content preserved verbatim.
    expect(out).toContain(`[mcp_servers.local]`);
    expect(out).toContain(`command = "node"`);
    // Marker block present, and placed BEFORE the user's [mcp_servers.local]
    // table — otherwise our root-level keys (model_provider, model) would be
    // absorbed into the user's last table by TOML's section semantics.
    expect(out).toContain(MARKER_BEGIN);
    expect(out).toContain(MARKER_END);
    expect(out).toContain('base_url = "http://127.0.0.1:23337/codex/v1"');
    expect(out).toContain('model = "gpt-5"');
    expect(out).toContain("__agent_maestro_managed = true");
    expect(out.indexOf(MARKER_END)).toBeLessThan(
      out.indexOf("[mcp_servers.local]"),
    );
    expect(out.indexOf(MARKER_BEGIN)).toBe(0);
  });

  it("re-applying with a new model only replaces the managed block", () => {
    const userToml = `[mcp_servers.local]\ncommand = "node"\n`;
    const first = renderManagedBlock({ port: 23337, modelId: "gpt-5" });
    const second = renderManagedBlock({ port: 23337, modelId: "gpt-5-mini" });

    const after1 = spliceManagedBlock(userToml, first);
    const after2 = spliceManagedBlock(after1, second);

    // User content untouched.
    expect(after2).toContain(`[mcp_servers.local]`);
    expect(after2).toContain(`command = "node"`);
    // Old model stripped, new model present.
    expect(after2).not.toContain('model = "gpt-5"\n');
    expect(after2).toContain('model = "gpt-5-mini"');
    // Exactly one marker block, not two.
    expect(after2.split(MARKER_BEGIN)).toHaveLength(2);
    expect(after2.split(MARKER_END)).toHaveLength(2);
  });

  it("migrates a block that was previously appended at the bottom to the top", () => {
    // Simulate a file written by the old (append-at-bottom) implementation.
    const block = renderManagedBlock({ port: 23337, modelId: "gpt-5" });
    const legacyToml =
      `[mcp_servers.local]\ncommand = "node"\n\n` +
      `${MARKER_BEGIN}\n${block}\n${MARKER_END}\n`;

    const newBlock = renderManagedBlock({ port: 23337, modelId: "gpt-5" });
    const out = spliceManagedBlock(legacyToml, newBlock);

    // Block is now at the top, user content below.
    expect(out.indexOf(MARKER_BEGIN)).toBe(0);
    expect(out.indexOf(MARKER_END)).toBeLessThan(
      out.indexOf("[mcp_servers.local]"),
    );
    // No duplicated marker block left at the bottom.
    expect(out.split(MARKER_BEGIN)).toHaveLength(2);
  });

  it("removing the managed block leaves user content untouched", () => {
    const userToml = `[mcp_servers.local]\ncommand = "node"\n`;
    const block = renderManagedBlock({ port: 23337, modelId: "gpt-5" });
    const applied = spliceManagedBlock(userToml, block);
    const removed = spliceManagedBlock(applied, null);
    // Should be identical to the original (modulo trailing newline normalisation).
    expect(removed.trim()).toBe(userToml.trim());
    expect(removed).not.toContain(MARKER_BEGIN);
    expect(removed).not.toContain(MARKER_END);
  });

  it("removing when there is no user content yields empty string", () => {
    const block = renderManagedBlock({ port: 23337, modelId: "gpt-5" });
    const applied = spliceManagedBlock("", block);
    const removed = spliceManagedBlock(applied, null);
    expect(removed).toBe("");
  });

  it("apply→remove→apply→remove is idempotent (no accumulating blank lines)", () => {
    const user = `[mcp_servers.local]\ncommand = "node"\n`;
    const block = renderManagedBlock({ port: 23337, modelId: "gpt-5" });
    const cycled = [0, 0, 0].reduce(
      (acc) => spliceManagedBlock(spliceManagedBlock(acc, block), null),
      user,
    );
    expect(cycled.trim()).toBe(user.trim());
  });

  it("renders TOML that escapes embedded quotes and backslashes safely", () => {
    const block = renderManagedBlock({
      port: 23337,
      modelId: 'weird"id\\here',
    });
    expect(block).toContain('model = "weird\\"id\\\\here"');
  });
});
