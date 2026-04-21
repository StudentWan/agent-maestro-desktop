import { execFile as execFileCb } from "node:child_process";

export type WindowTitleRunner = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: WindowTitleRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFileCb(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * Inline PowerShell that uses Win32 EnumWindows + GetWindowText to enumerate
 * every visible top-level window title. Output is a single JSON array so it
 * is trivial to parse from Node.
 *
 * Variable names avoid PowerShell automatic variables ($pid, $error, etc.).
 */
const WINDOW_ENUM_PS = `
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
  public delegate bool EnumDelegate(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumDelegate lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
Add-Type -TypeDefinition $src -Language CSharp -ErrorAction SilentlyContinue
$titles = New-Object 'System.Collections.Generic.List[string]'
$cb = [WinEnum+EnumDelegate]{
  param($h,$l)
  if ([WinEnum]::IsWindowVisible($h)) {
    $len = [WinEnum]::GetWindowTextLength($h)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 1)
      [void][WinEnum]::GetWindowText($h, $sb, $sb.Capacity)
      $titles.Add($sb.ToString())
    }
  }
  return $true
}
[void][WinEnum]::EnumWindows($cb, [IntPtr]::Zero)
if ($titles.Count -eq 0) { '[]' } else { $titles | ConvertTo-Json -Compress }
`.trim();

export function parseWindowTitles(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) {
    return parsed.filter((s): s is string => typeof s === "string");
  }
  if (typeof parsed === "string") return [parsed];
  return [];
}

/**
 * Returns visible top-level window titles. Currently Windows-only — on
 * other platforms returns []. macOS/Linux can be added later via AppleScript
 * / wmctrl if needed.
 */
export async function listWindowTitles(
  platform: NodeJS.Platform = process.platform,
  runner: WindowTitleRunner = defaultRunner,
): Promise<string[]> {
  if (platform !== "win32") return [];
  try {
    const { stdout } = await runner("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOW_ENUM_PS,
    ]);
    return parseWindowTitles(stdout);
  } catch {
    return [];
  }
}

/**
 * Pull the codespace displayName out of a VS Code window title.
 * Accepted forms include:
 *   "<file> - <repo> [Codespaces: cautious space orbit] - Visual Studio Code"
 *   "<file> [Codespaces: name] - Visual Studio Code"
 */
export function extractCodespaceDisplayNameFromTitle(title: string): string | null {
  const m = title.match(/\[Codespaces?:\s*([^\]]+?)\s*\]/i);
  if (!m) return null;
  const name = m[1].trim();
  return name || null;
}
