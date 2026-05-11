import { execFile as execFileCb, spawn, type ChildProcess } from "node:child_process";
import { REMOTE_COMMAND_TIMEOUT_MS } from "../shared/constants";
import type { GhCliStatus, CodespaceInfo } from "./types";
import { MIN_GH_CLI_VERSION } from "./types";

/**
 * Build a child-process env that injects our GitHub OAuth token via GH_TOKEN.
 *
 * `gh` honors GH_TOKEN over its own auth state, so this lets us authenticate
 * without depending on the user having run `gh auth login` (or having the
 * `codespace` scope on their local gh auth).
 *
 * When token is undefined, we fall back to the parent env so existing
 * behavior (using the user's `gh auth`) is preserved.
 */
function envWithToken(token?: string): NodeJS.ProcessEnv {
  if (!token) return process.env;
  return { ...process.env, GH_TOKEN: token };
}

function execFilePromise(
  cmd: string,
  args: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(
      cmd,
      args,
      { timeout: options?.timeout, env: options?.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function parseGhVersion(output: string): string | null {
  const match = output.match(/gh version (\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function checkGhCli(): Promise<GhCliStatus> {
  const result: GhCliStatus = {
    installed: false,
    meetsMinVersion: false,
    authenticated: false,
    hasCodespaceScope: false,
  };

  try {
    const { stdout } = await execFilePromise("gh", ["--version"]);
    const version = parseGhVersion(stdout);
    if (!version) return result;

    result.installed = true;
    result.version = version;
    result.meetsMinVersion = compareVersions(version, MIN_GH_CLI_VERSION) >= 0;
  } catch {
    return result;
  }

  try {
    const { stdout } = await execFilePromise("gh", ["auth", "status"]);
    result.authenticated = stdout.includes("Logged in");
    result.hasCodespaceScope = stdout.includes("codespace");
  } catch {
    result.authenticated = false;
  }

  return result;
}

export async function listCodespaces(token?: string): Promise<CodespaceInfo[]> {
  const { stdout } = await execFilePromise(
    "gh",
    ["api", "/user/codespaces", "--jq", ".codespaces"],
    { timeout: REMOTE_COMMAND_TIMEOUT_MS, env: envWithToken(token) },
  );

  const raw = JSON.parse(stdout) as Array<{
    id: number;
    name: string;
    display_name?: string;
    state: string;
    repository: { full_name: string };
    machine?: { display_name?: string };
    last_used_at: string;
  }>;

  return raw.map((cs) => ({
    id: cs.id,
    name: cs.name,
    displayName: cs.display_name ?? cs.name,
    repository: cs.repository.full_name,
    state: cs.state,
    machine: cs.machine?.display_name ?? "unknown",
    lastUsedAt: cs.last_used_at,
  }));
}

export async function startCodespace(name: string, token?: string): Promise<void> {
  await execFilePromise(
    "gh",
    ["api", "-X", "POST", `/user/codespaces/${name}/start`],
    { timeout: REMOTE_COMMAND_TIMEOUT_MS, env: envWithToken(token) },
  );
}

export function spawnSshTunnel(
  codespaceName: string,
  remotePort: number,
  localPort: number,
  token?: string,
): ChildProcess {
  return spawn(
    "gh",
    [
      "codespace", "ssh",
      "--codespace", codespaceName,
      "--",
      "-R", `${remotePort}:127.0.0.1:${localPort}`,
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-N",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: envWithToken(token),
    },
  );
}

export async function executeRemoteCommand(
  codespaceName: string,
  command: string,
  timeoutMs = REMOTE_COMMAND_TIMEOUT_MS,
  token?: string,
): Promise<string> {
  const { stdout } = await execFilePromise(
    "gh",
    ["codespace", "ssh", "--codespace", codespaceName, "--", command],
    { timeout: timeoutMs, env: envWithToken(token) },
  );
  return stdout;
}

/**
 * Verify the reverse SSH tunnel is actually accepting connections by opening
 * a TCP socket to 127.0.0.1:remotePort *from inside the codespace*. A bare
 * SSH process being alive does NOT imply `-R` has bound and is forwarding —
 * the kernel may not have set up the listening socket yet when SSH first
 * reports the channel as open.
 *
 * Implemented as a single SSH exec running a bash loop in the codespace, so
 * a fast-bound tunnel returns in ~1s without spamming SSH with poll-per-tick
 * sessions. The bash loop polls every 500ms for at most `timeoutSec` seconds.
 *
 * Returns true iff the codespace observed a successful connect within the
 * window. Any error (SSH failure, gh CLI hiccup) yields false — the caller
 * decides what to do with that.
 */
export async function probeReverseTunnel(
  codespaceName: string,
  remotePort: number,
  timeoutSec: number,
  token?: string,
): Promise<boolean> {
  const iterations = Math.max(1, Math.floor(timeoutSec * 2));
  // Single quotes inside the bash -c string are safe because we wrap with
  // double quotes; the inner script does not need any host-side variable
  // expansion (REMOTE_PORT is a JS template substitution, not a shell var).
  const script =
    `for i in $(seq 1 ${iterations}); do ` +
    `if (exec 3<>/dev/tcp/127.0.0.1/${remotePort}) 2>/dev/null; then ` +
    `exec 3<&-; exec 3>&-; echo READY; exit 0; fi; ` +
    `sleep 0.5; done; echo NOT_READY; exit 1`;
  const cmd = `bash -c '${script}'`;
  // Generous overhead over the bash loop so the SSH exec itself isn't what
  // times out: bash needs ≈ timeoutSec, SSH handshake adds a few seconds.
  const sshTimeoutMs = (timeoutSec + 10) * 1000;
  try {
    const out = await executeRemoteCommand(codespaceName, cmd, sshTimeoutMs, token);
    return out.includes("READY");
  } catch {
    return false;
  }
}
