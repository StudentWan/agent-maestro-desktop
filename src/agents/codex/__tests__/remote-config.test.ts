import { describe, expect, it } from "vitest";
import {
  CODEX_VERIFY_MARKER_COMMAND,
  buildRemoveCodexConfigScript,
  buildUpdateCodexModelScript,
  buildWriteCodexConfigScript,
} from "../remote-config";

describe("Codex remote-config script generators", () => {
  it("write script targets the right path, port, provider, and model", () => {
    const script = buildWriteCodexConfigScript(23337, "gpt-5");
    expect(script).toContain("python3 <<'PY_HEREDOC'");
    expect(script).toContain("PY_HEREDOC");
    expect(script).toContain("~/.codex/config.toml");
    expect(script).toContain("agent-maestro");
    expect(script).toContain("http://127.0.0.1:23337/codex/v1");
    expect(script).toContain("data['model'] = 'gpt-5'");
    expect(script).toContain("'request_timeout': 600");
  });

  it("write script omits the model assignment when model is empty", () => {
    const script = buildWriteCodexConfigScript(23337, "");
    expect(script).not.toContain("data['model'] =");
    // The provider lines must still be there.
    expect(script).toContain("'model_provider'");
    expect(script).toContain("http://127.0.0.1:23337/codex/v1");
  });

  it("write script embeds the shared atomic-dump and parse helpers", () => {
    const script = buildWriteCodexConfigScript(23337, "gpt-5");
    expect(script).toContain("_atomic_dump_text");
    expect(script).toContain("_read_config");
    expect(script).toContain("_toml_dump");
    // tomllib (3.11+) with tomli + embedded-parser fallback for 3.10
    // codespace images.
    expect(script).toContain("import tomllib");
    expect(script).toContain("import tomli");
    expect(script).toContain("def _parse_toml(");
  });

  it("update-model script sets only the model field", () => {
    const script = buildUpdateCodexModelScript("gpt-5-mini");
    expect(script).toContain("data['model'] = 'gpt-5-mini'");
    // Should NOT re-write the provider config — that's a separate concern.
    expect(script).not.toContain("'base_url'");
    expect(script).not.toContain("'wire_api'");
  });

  it("remove script deletes our provider entries by key", () => {
    const script = buildRemoveCodexConfigScript();
    expect(script).toContain("del data['model_provider']");
    expect(script).toContain("del mps['agent-maestro']");
    expect(script).toContain("_atomic_dump_text");
  });

  it("verify command counts occurrences of the provider section header", () => {
    expect(CODEX_VERIFY_MARKER_COMMAND).toContain("model_providers.agent-maestro");
    expect(CODEX_VERIFY_MARKER_COMMAND).toContain("grep -cF");
    expect(CODEX_VERIFY_MARKER_COMMAND).toContain("~/.codex/config.toml");
  });

  it("escapes single quotes / backslashes from the model id (script injection guard)", () => {
    const script = buildWriteCodexConfigScript(23337, "gpt-5'; rm -rf ~");
    expect(script).not.toContain("'; rm -rf ~");
  });

  it("write script embeds model_context_window when contextWindow is provided", () => {
    const script = buildWriteCodexConfigScript(23337, "gpt-5.5", {
      contextWindow: 922000,
    });
    expect(script).toContain("data['model_context_window'] = 922000");
  });

  it("write script omits model_context_window when contextWindow is missing or invalid", () => {
    for (const opts of [
      undefined,
      {},
      { contextWindow: 0 },
      { contextWindow: -1 },
      { contextWindow: Number.NaN },
    ]) {
      const script = buildWriteCodexConfigScript(23337, "gpt-5.5", opts);
      expect(script).not.toContain("data['model_context_window']");
    }
  });

  it("update-model script writes model_context_window when contextWindow is provided", () => {
    const script = buildUpdateCodexModelScript("gpt-4o", { contextWindow: 64000 });
    expect(script).toContain("data['model'] = 'gpt-4o'");
    expect(script).toContain("data['model_context_window'] = 64000");
  });

  it("update-model script omits model_context_window when not provided (does not clobber remote)", () => {
    const script = buildUpdateCodexModelScript("gpt-4o");
    expect(script).not.toContain("data['model_context_window']");
  });

  it("rejects non-integer / injection attempts in contextWindow (only digits embedded)", () => {
    // The signature is `number`, but a malicious caller could pass NaN /
    // Infinity / a fractional value. Floor + finite-check guards the inline.
    const script = buildWriteCodexConfigScript(23337, "gpt-5.5", {
      contextWindow: 922000.7 as number,
    });
    expect(script).toContain("data['model_context_window'] = 922000");
    expect(script).not.toContain("922000.7");
  });
});
