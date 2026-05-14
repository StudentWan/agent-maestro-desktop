import {
  APP_USER_AGENT,
  COPILOT_DEFAULT_API_BASE_URL,
  COPILOT_TOKEN_URL,
  EDITOR_PLUGIN_VERSION,
  EDITOR_VERSION,
  TOKEN_REFRESH_INTERVAL_MS,
} from "../shared/constants";
import type { CopilotToken } from "./types";

function parseExpiresAtSeconds(expiresAt: number | string): number {
  const parsed = typeof expiresAt === "number" ? expiresAt : Number.parseInt(expiresAt, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error("Copilot token response has invalid expires_at");
  }
  return parsed > 100_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
}

function resolveCopilotProxyHost(proxyEndpoint: string): string | null {
  const trimmed = proxyEndpoint.trim();
  if (!trimmed) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  const urlText = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(urlText);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function deriveCopilotApiBaseUrlFromToken(token: string): string | null {
  const match = token.trim().match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEndpoint = match?.[1];
  if (!proxyEndpoint) {
    return null;
  }

  const proxyHost = resolveCopilotProxyHost(proxyEndpoint);
  if (!proxyHost) {
    return null;
  }

  return `https://${proxyHost.replace(/^proxy\./i, "api.")}`;
}

/**
 * Manages the short-lived Copilot API token lifecycle:
 * - Fetches initial token using GitHub access token
 * - Auto-refreshes every 25 minutes (JWT expires after 30 min)
 * - Provides current valid token for API requests
 */
export class TokenManager {
  private githubAccessToken: string;
  private currentToken: CopilotToken | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private onTokenRefreshed?: (token: CopilotToken) => void;
  private onTokenError?: (error: Error) => void;

  constructor(
    githubAccessToken: string,
    callbacks?: {
      onTokenRefreshed?: (token: CopilotToken) => void;
      onTokenError?: (error: Error) => void;
    },
  ) {
    this.githubAccessToken = githubAccessToken;
    this.onTokenRefreshed = callbacks?.onTokenRefreshed;
    this.onTokenError = callbacks?.onTokenError;
  }

  /**
   * Initialize: fetch the first token and start auto-refresh
   */
  async initialize(): Promise<CopilotToken> {
    const token = await this.fetchToken();
    this.currentToken = token;
    this.startAutoRefresh();
    return token;
  }

  /**
   * Get the current valid token, refreshing if expired
   */
  async getToken(): Promise<string> {
    return (await this.getTokenBundle()).token;
  }

  /**
   * Get the current valid token and matching Copilot API base URL.
   */
  async getTokenBundle(): Promise<CopilotToken> {
    if (!this.currentToken || this.isExpired()) {
      this.currentToken = await this.fetchToken();
    }
    return this.currentToken;
  }

  /**
   * Get token expiry info
   */
  getTokenInfo(): { token: string | null; expiresAt: number | null; remainingSeconds: number | null } {
    if (!this.currentToken) {
      return { token: null, expiresAt: null, remainingSeconds: null };
    }
    const remaining = Math.max(0, Math.floor((this.currentToken.expiresAt * 1000 - Date.now()) / 1000));
    return {
      token: this.currentToken.token.slice(0, 20) + "...",
      expiresAt: this.currentToken.expiresAt,
      remainingSeconds: remaining,
    };
  }

  /**
   * Stop auto-refresh and clean up
   */
  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.currentToken = null;
  }

  /**
   * Update the GitHub access token (e.g. after re-login)
   */
  updateAccessToken(token: string): void {
    this.githubAccessToken = token;
    this.currentToken = null;
  }

  private isExpired(): boolean {
    if (!this.currentToken) return true;
    // Consider expired 60s before actual expiry
    return Date.now() >= (this.currentToken.expiresAt * 1000 - 60_000);
  }

  private async fetchToken(): Promise<CopilotToken> {
    const response = await fetch(COPILOT_TOKEN_URL, {
      headers: {
        "Authorization": `Bearer ${this.githubAccessToken}`,
        "Accept": "application/json",
        "Editor-Version": EDITOR_VERSION,
        "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
        "User-Agent": APP_USER_AGENT,
        "X-Github-Api-Version": "2025-04-01",
        "Copilot-Integration-Id": "vscode-chat",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Copilot token fetch failed (${response.status}): ${body}`);
    }

    const data = await response.json() as { token: string; expires_at: number | string };
    return {
      token: data.token,
      expiresAt: parseExpiresAtSeconds(data.expires_at),
      baseUrl: deriveCopilotApiBaseUrlFromToken(data.token) ?? COPILOT_DEFAULT_API_BASE_URL,
    };
  }

  private startAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    this.refreshTimer = setInterval(async () => {
      try {
        this.currentToken = await this.fetchToken();
        console.log("[TokenManager] Token refreshed, expires at:", new Date(this.currentToken.expiresAt * 1000).toISOString());
        this.onTokenRefreshed?.(this.currentToken);
      } catch (error) {
        console.error("[TokenManager] Token refresh failed:", error);
        this.onTokenError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }, TOKEN_REFRESH_INTERVAL_MS);
  }
}
