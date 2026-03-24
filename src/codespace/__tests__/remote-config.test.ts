import { describe, it, expect } from "vitest";
import {
  buildWriteConfigScript,
  buildRemoveConfigScript,
  buildUpdateModelScript,
  buildWriteOnboardingScript,
} from "../remote-config";

describe("buildWriteConfigScript", () => {
  it("generates valid python3 script with port and model", () => {
    const script = buildWriteConfigScript(23337, "claude-sonnet-4-20250514");
    expect(script).toContain("python3 -c");
    expect(script).toContain("23337");
    expect(script).toContain("claude-sonnet-4-20250514");
    expect(script).toContain("ANTHROPIC_BASE_URL");
    expect(script).toContain("AGENT_MAESTRO_MANAGED");
  });

  it("escapes special characters in model name", () => {
    const script = buildWriteConfigScript(23337, "model-with'quotes");
    expect(script).not.toContain("'quotes");
    expect(script).toContain("model-with");
  });
});

describe("buildRemoveConfigScript", () => {
  it("generates valid python3 cleanup script", () => {
    const script = buildRemoveConfigScript();
    expect(script).toContain("python3 -c");
    expect(script).toContain("AGENT_MAESTRO_MANAGED");
    expect(script).toContain("pop");
  });
});

describe("buildUpdateModelScript", () => {
  it("generates python3 script that updates only model", () => {
    const script = buildUpdateModelScript("claude-opus-4-20250514");
    expect(script).toContain("python3 -c");
    expect(script).toContain("ANTHROPIC_MODEL");
    expect(script).toContain("claude-opus-4-20250514");
    expect(script).toContain("AGENT_MAESTRO_MANAGED");
  });
});

describe("buildWriteOnboardingScript", () => {
  it("generates python3 script for claude.json", () => {
    const script = buildWriteOnboardingScript();
    expect(script).toContain("python3 -c");
    expect(script).toContain("hasCompletedOnboarding");
    expect(script).toContain(".claude.json");
  });
});
