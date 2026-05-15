import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentLocalConfigSnippet } from "../types";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
const CLAUDE_JSON_PATH = path.join(os.homedir(), ".claude.json");

const AUTH_TOKEN_VALUE = "Powered by Agent Maestro Desktop";
const MODEL_ENV_KEY = "ANTHROPIC_MODEL";

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function writeJsonFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Write Claude Code config files so it uses our proxy automatically.
 * Merge strategy: preserves all existing settings, only sets our env vars.
 */
export async function applyClaudeConfig(port: number): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. ~/.claude/settings.json — merge env vars
  const settings = await readJsonFile(SETTINGS_PATH);
  const existingEnv = (settings.env ?? {}) as Record<string, string>;
  const newSettings = {
    ...settings,
    env: {
      ...existingEnv,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN_VALUE,
    },
  };
  await writeJsonFile(SETTINGS_PATH, newSettings);

  // 2. ~/.claude/config.json — leave untouched (no API key needed)

  // 3. ~/.claude.json — ensure onboarding is complete
  const claudeJson = await readJsonFile(CLAUDE_JSON_PATH);
  if (claudeJson.hasCompletedOnboarding !== true) {
    await writeJsonFile(CLAUDE_JSON_PATH, { ...claudeJson, hasCompletedOnboarding: true });
  }

  console.log(`[ClaudeConfig] Applied — ANTHROPIC_BASE_URL=${baseUrl}`);
}

/**
 * Remove our proxy settings from Claude Code config files.
 * Only removes values that match ours — never touches user-set values.
 */
export async function removeClaudeConfig(port: number): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. ~/.claude/settings.json — remove only our env vars
  const settings = await readJsonFile(SETTINGS_PATH);
  const env = (settings.env ?? {}) as Record<string, string>;
  const cleanedEnv = { ...env };

  if (cleanedEnv.ANTHROPIC_BASE_URL === baseUrl) {
    delete cleanedEnv.ANTHROPIC_BASE_URL;
  }
  if (cleanedEnv.ANTHROPIC_AUTH_TOKEN === AUTH_TOKEN_VALUE) {
    delete cleanedEnv.ANTHROPIC_AUTH_TOKEN;
  }

  const newSettings: Record<string, unknown> = { ...settings, env: cleanedEnv };
  if (Object.keys(cleanedEnv).length === 0) {
    delete newSettings.env;
  }
  await writeJsonFile(SETTINGS_PATH, newSettings);

  // 2. ~/.claude/config.json — leave untouched

  // 3. ~/.claude.json — leave untouched (don't re-trigger onboarding)

  console.log("[ClaudeConfig] Removed proxy settings");
}

/**
 * Write the selected model to Claude Code config.
 * Sets ANTHROPIC_MODEL env var in ~/.claude/settings.json
 */
export async function writeModelToClaudeConfig(modelId: string): Promise<void> {
  const settings = await readJsonFile(SETTINGS_PATH);
  const existingEnv = (settings.env ?? {}) as Record<string, string>;
  const newSettings = {
    ...settings,
    env: {
      ...existingEnv,
      [MODEL_ENV_KEY]: modelId,
    },
  };
  await writeJsonFile(SETTINGS_PATH, newSettings);
  console.log(`[ClaudeConfig] Model set to: ${modelId}`);
}

/**
 * Snippet shown in the renderer's AgentConfigPanel for Claude.
 *
 * Claude is configured purely through env vars (no separate config file
 * we need to expose to the user) — Claude Code reads `ANTHROPIC_BASE_URL`
 * and `ANTHROPIC_AUTH_TOKEN` from `~/.claude/settings.json`'s `env` block,
 * which we manage automatically. The snippet helps users who want to wire
 * up another Anthropic-API-aware tool by hand.
 */
export function getClaudeConfigSnippet(
  port: number,
  modelId: string | null,
): AgentLocalConfigSnippet {
  const baseUrl = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN_VALUE,
  };
  if (modelId) {
    env[MODEL_ENV_KEY] = modelId;
  }
  return {
    envLabel: "Claude Code env (auto-applied to ~/.claude/settings.json)",
    envVars: env,
  };
}
