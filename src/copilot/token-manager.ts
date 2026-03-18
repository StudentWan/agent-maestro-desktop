import { COPILOT_TOKEN_URL, TOKEN_REFRESH_INTERVAL_MS } from "../shared/constants";
import type { CopilotToken } from "./types";

/**
 * Manages the Copilot JWT token lifecycle:
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
    if (!this.currentToken || this.isExpired()) {
      this.currentToken = await this.fetchToken();
    }
    return this.currentToken.token;
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
        "Authorization": `token ${this.githubAccessToken}`,
        "Accept": "application/json",
        "Editor-Version": "vscode/1.99.0",
        "Editor-Plugin-Version": "copilot-chat/0.24.2",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Copilot token fetch failed (${response.status}): ${body}`);
    }

    const data = await response.json() as { token: string; expires_at: number };
    return {
      token: data.token,
      expiresAt: data.expires_at,
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
