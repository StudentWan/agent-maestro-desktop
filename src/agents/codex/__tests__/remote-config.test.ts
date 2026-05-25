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
    // tomllib (3.11+) with tomli fallback.
    expect(script).toContain("import tomllib");
    expect(script).toContain("import tomli");
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
});
