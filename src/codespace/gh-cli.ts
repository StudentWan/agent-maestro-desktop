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
      // Prevent SSH connection sharing: config-write commands (which run
      // via separate `gh codespace ssh` invocations) could otherwise
      // multiplex over this connection's control socket. If a config-write
      // session triggers a channel error, it would tear down the shared
      // connection — killing the reverse port forward even though the SSH
      // process stays alive. Isolating the tunnel avoids this.
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
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
 * Verify the reverse SSH tunnel is actually forwarding HTTP traffic by
 * hitting the proxy's /health endpoint from inside the codespace.
 *
 * Previous implementation only tested TCP connectivity (bash /dev/tcp),
 * which can give false positives: SSH may bind the listening port before
 * the forwarding channel is fully operational, so a bare socket connect
 * succeeds but actual data never reaches the local proxy.
 *
 * Now prefers `curl -sf /health` for a true end-to-end check (HTTP
 * request → tunnel → local proxy → 200 response → back). Falls back to
 * the /dev/tcp probe when curl is not installed in the codespace image
 * (rare but possible in stripped-down containers).
 *
 * Returns true iff the codespace observed a successful response within
 * the window. Any error (SSH failure, gh CLI hiccup) yields false — the
 * caller decides what to do with that.
 */
export async function probeReverseTunnel(
  codespaceName: string,
  remotePort: number,
  timeoutSec: number,
  token?: string,
): Promise<boolean> {
  const iterations = Math.max(1, Math.floor(timeoutSec * 2));
  // Prefer curl for end-to-end HTTP verification; fall back to TCP-only
  // (/dev/tcp) for images without curl. The curl path catches tunnels
  // that bind but don't forward — the most common false-positive.
  const script =
    `if command -v curl >/dev/null 2>&1; then ` +
    `for i in $(seq 1 ${iterations}); do ` +
    `if curl -sf --max-time 2 http://127.0.0.1:${remotePort}/health >/dev/null 2>&1; then ` +
    `echo READY; exit 0; fi; ` +
    `sleep 0.5; done; ` +
    `else ` +
    `for i in $(seq 1 ${iterations}); do ` +
    `if (exec 3<>/dev/tcp/127.0.0.1/${remotePort}) 2>/dev/null; then ` +
    `exec 3<&-; exec 3>&-; echo READY; exit 0; fi; ` +
    `sleep 0.5; done; ` +
    `fi; echo NOT_READY; exit 1`;
  const cmd = `bash -c '${script}'`;
  // Generous overhead over the bash loop so the SSH exec itself isn't what
  // times out: bash needs ≈ timeoutSec, SSH handshake adds a few seconds.
  const sshTimeoutMs = (timeoutSec + 10) * 1000;
  try {
    const out = await executeRemoteCommand(codespaceName, cmd, sshTimeoutMs, token);
    const ready = out.includes("READY");
    if (!ready) {
      console.warn(
        `[probeReverseTunnel] port ${remotePort} on ${codespaceName} not ready after ${timeoutSec}s ` +
          `(output: ${out.trim().slice(0, 120)})`,
      );
    }
    return ready;
  } catch (err) {
    console.warn(
      `[probeReverseTunnel] probe failed for port ${remotePort} on ${codespaceName}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
