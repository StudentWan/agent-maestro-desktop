import { execFile as execFileCb } from "node:child_process";

export interface ProcessInfo {
  pid: number;
  command: string;
}

export type ProcessRunner = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: ProcessRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFileCb(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Parse Windows PowerShell `Get-CimInstance Win32_Process | ... | ConvertTo-Json -Compress` output. */
export function parseWindowsProcesses(stdout: string): ProcessInfo[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProcessInfo[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const pidRaw = obj.ProcessId ?? obj.processId ?? obj.PID;
    const cmdRaw = obj.CommandLine ?? obj.commandLine ?? obj.Command;
    const pid = typeof pidRaw === "number" ? pidRaw : parseInt(String(pidRaw ?? ""), 10);
    if (!Number.isFinite(pid)) continue;
    const command = typeof cmdRaw === "string" ? cmdRaw : "";
    if (!command) continue;
    out.push({ pid, command });
  }
  return out;
}

/** Parse Unix `ps -A -o pid=,command=` output. */
export function parseUnixProcesses(stdout: string): ProcessInfo[] {
  const lines = stdout.split(/\r?\n/);
  const out: ProcessInfo[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (!Number.isFinite(pid)) continue;
    out.push({ pid, command: m[2] });
  }
  return out;
}

export async function listProcesses(
  platform: NodeJS.Platform = process.platform,
  runner: ProcessRunner = defaultRunner,
): Promise<ProcessInfo[]> {
  if (platform === "win32") {
    const { stdout } = await runner("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    return parseWindowsProcesses(stdout);
  }
  const { stdout } = await runner("ps", ["-A", "-o", "pid=,command="]);
  return parseUnixProcesses(stdout);
}
