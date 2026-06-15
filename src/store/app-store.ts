import Store from "electron-store";
import type { StoreSchema } from "../shared/types";
import { DEFAULT_PROXY_PORT } from "../shared/constants";

const store = new Store<StoreSchema>({
  defaults: {
    githubToken: null,
    codespaceToken: null,
    proxyPort: DEFAULT_PROXY_PORT,
    autoStart: true,
    minimizeToTray: true,
    selectedModels: {},
    selectedModelContextWindows: {},
  },
});

// One-shot migration from the legacy single-agent `selectedModel` key.
// We always lived with one agent (Claude) before plugins existed, so any
// previously-stored value belongs to Claude. After this runs the legacy
// key is cleared so the migration is idempotent.
(function migrateLegacySelectedModel() {
  const legacy = store.get("selectedModel");
  if (typeof legacy === "string" && legacy.length > 0) {
    const map = store.get("selectedModels");
    if (!map.claude) {
      store.set("selectedModels", { ...map, claude: legacy });
    }
  }
  if (legacy !== undefined) {
    store.delete("selectedModel" as keyof StoreSchema);
  }
})();

export function getGithubToken(): string | null {
  return store.get("githubToken");
}

export function setGithubToken(token: string | null): void {
  store.set("githubToken", token);
}

export function getCodespaceToken(): string | null {
  return store.get("codespaceToken");
}

export function setCodespaceToken(token: string | null): void {
  store.set("codespaceToken", token);
}

export function getProxyPort(): number {
  return store.get("proxyPort");
}

export function setProxyPort(port: number): void {
  store.set("proxyPort", port);
}

export function getAutoStart(): boolean {
  return store.get("autoStart");
}

export function setAutoStart(enabled: boolean): void {
  store.set("autoStart", enabled);
}

export function getMinimizeToTray(): boolean {
  return store.get("minimizeToTray");
}

/** Get the selected model id for one agent (null if never set). */
export function getSelectedModel(agentId: string): string | null {
  return store.get("selectedModels")[agentId] ?? null;
}

/** Set/clear the selected model id for one agent. */
export function setSelectedModel(agentId: string, model: string | null): void {
  const map = store.get("selectedModels");
  store.set("selectedModels", { ...map, [agentId]: model });
}

/** Snapshot of every agent's selected model (for the codespace auto-bridge). */
export function getAllSelectedModels(): Record<string, string> {
  const map = store.get("selectedModels");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = v ?? "";
  }
  return out;
}

/**
 * Get the cached max_prompt_tokens for one agent's currently selected
 * model (null if unknown — e.g. user is on the previous version that
 * didn't populate this field, or selection happened before the model
 * list returned).
 */
export function getSelectedModelContextWindow(agentId: string): number | null {
  const map = store.get("selectedModelContextWindows") ?? {};
  return map[agentId] ?? null;
}

/** Set/clear the cached context window for one agent. */
export function setSelectedModelContextWindow(
  agentId: string,
  contextWindow: number | null,
): void {
  const map = store.get("selectedModelContextWindows") ?? {};
  store.set("selectedModelContextWindows", {
    ...map,
    [agentId]: contextWindow,
  });
}

export default store;
