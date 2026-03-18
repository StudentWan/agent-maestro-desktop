import {
  GITHUB_CLIENT_ID,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_ACCESS_TOKEN_URL,
  DEVICE_FLOW_POLL_INTERVAL_MS,
} from "../shared/constants";
import type { DeviceCodeResponse, AccessTokenResponse } from "../shared/types";

/**
 * Start OAuth Device Flow: request a device code from GitHub
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!response.ok) {
    throw new Error(`Device code request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<DeviceCodeResponse>;
}

/**
 * Poll for the access token after user has authorized the device
 */
export async function pollForAccessToken(
  deviceCode: string,
  interval: number = DEVICE_FLOW_POLL_INTERVAL_MS,
  expiresIn: number = 900,
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
        client_id: GITHUB_CLIENT_ID,
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
