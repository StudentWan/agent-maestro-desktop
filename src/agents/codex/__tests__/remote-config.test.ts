import { describe, expect, it } from "vitest";
import {
  CODEX_VERIFY_MARKER_COMMAND,
  buildRemoveCodexConfigScript,
  buildUpdateCodexModelScript,
  buildWriteCodexConfigScript,
} from "../remote-config";

describe("Codex remote-config script generators", () => {
  it("write script targets the right path, port, and provider", () => {
    const script = buildWriteCodexConfigScript(23337, "gpt-5");
    expect(script).toContain("python3 -c");
    expect(script).toContain("~/.codex/config.toml");
    expect(script).toContain("agent-maestro");
    expect(script).toContain("http://127.0.0.1:23337/codex/v1");
    expect(script).toContain('model = \\"gpt-5\\"');
    expect(script).toContain("__agent_maestro_managed = true");
  });

  it("write script embeds the shared atomic-dump helper", () => {
    const script = buildWriteCodexConfigScript(23337, "gpt-5");
    // Helper exposed via the shared module — exact name lives there. We
    // grep for the function name to assert the include actually happened.
    expect(script).toContain("_atomic_dump_text");
  });

  it("update-model script names the new model and references the splice helper", () => {
    const script = buildUpdateCodexModelScript("gpt-5-mini");
    expect(script).toContain('model = \\"gpt-5-mini\\"');
    expect(script).toContain("_splice_block");
  });

  it("remove script splices None into the managed block", () => {
    const script = buildRemoveCodexConfigScript();
    expect(script).toContain("body = None");
    expect(script).toContain("_splice_block");
  });

  it("verify command counts occurrences of the marker key", () => {
    expect(CODEX_VERIFY_MARKER_COMMAND).toContain("agent-maestro-managed");
    expect(CODEX_VERIFY_MARKER_COMMAND).toContain("grep -c");
    expect(CODEX_VERIFY_MARKER_COMMAND).toContain("~/.codex/config.toml");
  });

  it("escapes single quotes / backslashes from the model id (script injection guard)", () => {
    const script = buildWriteCodexConfigScript(23337, "gpt-5'; rm -rf ~");
    expect(script).not.toContain("'; rm -rf ~");
  });
});
