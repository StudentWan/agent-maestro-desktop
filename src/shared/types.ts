// Auth
export interface AuthStatus {
  authenticated: boolean;
  username?: string;
  loginUrl?: string;
  userCode?: string;
  /**
   * Scopes from REQUIRED_OAUTH_SCOPES that the current token is missing.
   * Empty array (or undefined when not authenticated) means the token has
   * everything it needs. Surfaced in the UI as a "Re-authorize" prompt
   * when non-empty.
   */
  missingScopes?: string[];
  /** Optional error message from the last auth operation. */
  error?: string;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  endpoints?: {
    api: string;
    "origin-tracker": string;
    proxy: string;
    telemetry: string;
  };
}

// Proxy
export interface ProxyStatus {
  running: boolean;
  port: number;
  requestCount: number;
}

// Token
export interface TokenInfo {
  token: string | null;
  expiresAt: number | null;
  remainingSeconds: number | null;
}

// Request log
export interface UpstreamErrorInfo {
  /** HTTP status the upstream Copilot endpoint returned (e.g. 502). */
  status: number;
  /**
   * Raw response body from the upstream. Truncated by
   * `truncateUpstreamBody` in `src/copilot/upstream-error.ts` before it
   * crosses the IPC boundary so we never ship multi-MB HTML error pages
   * to the renderer.
   */
  body: string;
}

export interface RequestLogEntry {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  model: string;
  status: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  thinkingLevel?: string;
  stream: boolean;
  /** Short, human-friendly error message (exception .message or similar). */
  error?: string;
  /**
   * Present only when the failure was a non-OK HTTP response from the
   * upstream Copilot API. The renderer surfaces `body` verbatim in the
   * expandable row so users can diagnose 502s / context-exceeded / auth
   * failures without scraping logs.
   */
  upstreamError?: UpstreamErrorInfo;
}

// Config — generic top-level
export interface AppConfig {
  proxyPort: number;
}

// Store
export interface StoreSchema {
  githubToken: string | null;
  /**
   * Token from the secondary device flow (gh CLI client_id) carrying the
   * `codespace` scope. Stored separately from githubToken because the
   * Copilot OAuth App can't grant `codespace` itself.
   */
  codespaceToken: string | null;
  proxyPort: number;
  autoStart: boolean;
  minimizeToTray: boolean;
  /**
   * Per-agent selected model id. Keys are agent ids (e.g. "claude",
   * "codex"). The legacy `selectedModel` (a single string) is migrated
   * into `selectedModels.claude` on first read of the store — see
   * `src/store/app-store.ts` migration block.
   */
  selectedModels: Record<string, string | null>;
  /** @deprecated kept for one release so the migration can find it. */
  selectedModel?: string | null;
}
