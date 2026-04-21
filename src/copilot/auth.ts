import {
  GITHUB_CLIENT_ID,
  GITHUB_CLI_CLIENT_ID,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_ACCESS_TOKEN_URL,
  COPILOT_OAUTH_SCOPES,
  CODESPACE_OAUTH_SCOPES,
  REQUIRED_CODESPACE_SCOPES,
  DEVICE_FLOW_POLL_INTERVAL_MS,
} from "../shared/constants";
import type { DeviceCodeResponse, AccessTokenResponse } from "../shared/types";

export interface TokenScopeStatus {
  /** All scopes the token actually has, parsed from X-OAuth-Scopes header. */
  scopes: string[];
  /** Scopes from the required list that the token is missing. */
  missingScopes: string[];
  /** Convenience: true iff missingScopes is empty. */
  hasAllRequiredScopes: boolean;
}

async function requestDeviceCodeFor(
  clientId: string,
  scope: string,
): Promise<DeviceCodeResponse> {
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      scope,
    }),
  });

  if (!response.ok) {
    throw new Error(`Device code request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<DeviceCodeResponse>;
}

/**
 * Primary Copilot device flow. Asks for `read:user`, which is what the
 * Copilot OAuth App actually has registered. Resulting token authenticates
 * Copilot API calls.
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  return requestDeviceCodeFor(GITHUB_CLIENT_ID, COPILOT_OAUTH_SCOPES);
}

/**
 * Secondary device flow that asks for `codespace` scope via the public
 * GitHub CLI OAuth App. We need a different client_id because the Copilot
 * OAuth App does not list `codespace` as an allowed scope and silently
 * drops it on the primary flow.
 */
export async function requestCodespaceDeviceCode(): Promise<DeviceCodeResponse> {
  return requestDeviceCodeFor(GITHUB_CLI_CLIENT_ID, CODESPACE_OAUTH_SCOPES);
}

async function pollForAccessTokenFor(
  clientId: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);

    const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!response.ok) {
      throw new Error(`Token polling failed: ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>;

    if (data.access_token) {
      return data.access_token as string;
    }

    const error = data.error as string | undefined;
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (error === "expired_token") {
      throw new Error("Device code expired. Please try again.");
    }
    if (error === "access_denied") {
      throw new Error("Authorization was denied by the user.");
    }
    if (error) {
      throw new Error(`OAuth error: ${error}`);
    }
  }

  throw new Error("Device code polling timed out.");
}

/**
 * Poll for the access token after user has authorized the device (Copilot client).
 */
export async function pollForAccessToken(
  deviceCode: string,
  interval: number = DEVICE_FLOW_POLL_INTERVAL_MS,
  expiresIn: number = 900,
): Promise<string> {
  return pollForAccessTokenFor(GITHUB_CLIENT_ID, deviceCode, interval, expiresIn);
}

/**
 * Poll for the codespace access token after authorization (gh CLI client).
 */
export async function pollForCodespaceAccessToken(
  deviceCode: string,
  interval: number = DEVICE_FLOW_POLL_INTERVAL_MS,
  expiresIn: number = 900,
): Promise<string> {
  return pollForAccessTokenFor(GITHUB_CLI_CLIENT_ID, deviceCode, interval, expiresIn);
}

/**
 * Get the GitHub username for a given access token
 */
export async function getGitHubUsername(accessToken: string): Promise<string> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": `token ${accessToken}`,
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub user: ${response.status}`);
  }

  const user = await response.json() as { login: string };
  return user.login;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the comma-separated `X-OAuth-Scopes` header GitHub returns on
 * authenticated requests. Whitespace tolerant; empty string → [].
 */
export function parseScopesHeader(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Compute which scopes from `required` are missing from `actual`.
 *
 * NOTE: scope inclusion is treated literally — we do not infer that
 * `repo` implies `public_repo`, nor that `codespace` implies anything else.
 * Pure function; easy to unit-test.
 */
export function computeMissingScopes(
  actual: readonly string[],
  required: readonly string[] = REQUIRED_CODESPACE_SCOPES,
): string[] {
  const have = new Set(actual);
  return required.filter((s) => !have.has(s));
}

/**
 * Hit `GET /user` with the token, read `X-OAuth-Scopes`, and report which
 * `required` scopes are missing. Used at startup and after login to decide
 * whether to surface a "re-authorize" prompt to the user.
 *
 * Throws on network failure / invalid token (401). Callers should treat a
 * thrown error as "unknown" and fall back to assuming scopes are missing.
 */
export async function checkTokenScopes(
  accessToken: string,
  required: readonly string[] = REQUIRED_CODESPACE_SCOPES,
): Promise<TokenScopeStatus> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": `token ${accessToken}`,
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to check token scopes: ${response.status}`);
  }

  const scopes = parseScopesHeader(response.headers.get("x-oauth-scopes"));
  const missingScopes = computeMissingScopes(scopes, required);
  return {
    scopes,
    missingScopes,
    hasAllRequiredScopes: missingScopes.length === 0,
  };
}
