// Auth
export interface AuthStatus {
  authenticated: boolean;
  username?: string;
  loginUrl?: string;
  userCode?: string;
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
  stream: boolean;
  error?: string;
}

// Config
export interface AppConfig {
  proxyPort: number;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  envVars: Record<string, string>;
}

// Store
export interface StoreSchema {
  githubToken: string | null;
  proxyPort: number;
  autoStart: boolean;
  minimizeToTray: boolean;
}
