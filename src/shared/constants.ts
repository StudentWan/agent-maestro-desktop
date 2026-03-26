// GitHub OAuth
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_DEVICE_VERIFICATION_URL = "https://github.com/login/device";

// Copilot API
export const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
export const COPILOT_CHAT_URL = "https://api.githubcopilot.com/chat/completions";

// Proxy
export const DEFAULT_PROXY_PORT = 23337;
export const PROXY_HOST = "127.0.0.1";

// Token refresh
export const TOKEN_REFRESH_INTERVAL_MS = 25 * 60 * 1000; // 25 minutes
export const TOKEN_EXPIRY_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// Device flow polling
export const DEVICE_FLOW_POLL_INTERVAL_MS = 5000;

// App
export const APP_NAME = "Agent Maestro Desktop";
export const APP_USER_AGENT = "GitHubCopilotChat/0.24.2";
export const EDITOR_VERSION = "vscode/1.99.0";
export const EDITOR_PLUGIN_VERSION = "copilot-chat/0.24.2";
export const MACHINE_ID = "machine-id-placeholder";

// Codespace
export const CODESPACE_HEALTH_CHECK_INTERVAL_MS = 30_000; // 30 seconds
export const CODESPACE_LIST_POLL_INTERVAL_MS = 60_000; // 60 seconds
export const SSH_TUNNEL_CONNECT_TIMEOUT_MS = 30_000; // 30 seconds
export const REMOTE_COMMAND_TIMEOUT_MS = 15_000; // 15 seconds
export const MAX_RECONNECT_ATTEMPTS = 5;
export const MAX_PORT_RETRIES = 3;

// Codespace auto-detection
export const VSCODE_DETECTOR_DEBOUNCE_MS = 1500;
export const VSCODE_DETECTOR_POLL_INTERVAL_MS = 10_000; // 10 seconds
