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
  error?: string;
}

// Config
export interface AppConfig {
  proxyPort: number;
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  envVars: Record<string, string>;
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
  selectedModel: string | null;
}

// Model info from Copilot
export interface ModelInfo {
  id: string;
  name: string;
}
