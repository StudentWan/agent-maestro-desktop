import Store from "electron-store";
import type { StoreSchema } from "../shared/types";
import { DEFAULT_PROXY_PORT } from "../shared/constants";

const store = new Store<StoreSchema>({
  defaults: {
    githubToken: null,
    proxyPort: DEFAULT_PROXY_PORT,
    autoStart: true,
    minimizeToTray: true,
    selectedModel: null,
  },
});

export function getGithubToken(): string | null {
  return store.get("githubToken");
}

export function setGithubToken(token: string | null): void {
  store.set("githubToken", token);
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

export function getSelectedModel(): string | null {
  return store.get("selectedModel");
}

export function setSelectedModel(model: string | null): void {
  store.set("selectedModel", model);
}

export default store;
