import { app, dialog } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import type { DiagnosticLogLevel, DiagnosticLogSaveResult } from "../shared/types";

const LOG_FILE_NAME = "agent-maestro.log";
const PREVIOUS_LOG_FILE_NAME = "agent-maestro.previous.log";
const MAX_LOG_BYTES = 3 * 1024 * 1024;
const LOG_METHODS = ["debug", "log", "info", "warn", "error"] as const;

type ConsoleMethod = (typeof LOG_METHODS)[number];

let logFilePath: string | null = null;
let previousLogFilePath: string | null = null;
let installed = false;
const originalConsole: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};

export function initializeDiagnostics(): string {
  const logsDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  logFilePath = path.join(logsDir, LOG_FILE_NAME);
  previousLogFilePath = path.join(logsDir, PREVIOUS_LOG_FILE_NAME);
  rotateLogIfNeeded(logFilePath, previousLogFilePath);

  installConsoleCapture();
  appendLogLine("info", [
    "[Diagnostics] Runtime log started",
    {
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      osRelease: os.release(),
      logFile: logFilePath,
    },
  ]);

  return logFilePath;
}

export async function saveDiagnosticLog(): Promise<DiagnosticLogSaveResult> {
  const currentPath = ensureDiagnosticsInitialized();
  appendLogLine("info", ["[Diagnostics] User requested diagnostic log export"]);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultPath = path.join(
    app.getPath("downloads"),
    `agent-maestro-diagnostics-${timestamp}.log`,
  );

  const result = await dialog.showSaveDialog({
    title: "Save Diagnostic Logs",
    defaultPath,
    filters: [
      { name: "Log files", extensions: ["log", "txt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });

  if (result.canceled || !result.filePath) {
    appendLogLine("info", ["[Diagnostics] Diagnostic log export canceled"]);
    return { canceled: true };
  }

  try {
    appendLogLine("info", ["[Diagnostics] Exporting diagnostic log", result.filePath]);
    const contents = await buildDiagnosticLogBundle(currentPath);
    await fs.promises.writeFile(result.filePath, contents, "utf8");
    appendLogLine("info", ["[Diagnostics] Diagnostic log exported", result.filePath]);
    return { canceled: false, filePath: result.filePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLogLine("error", ["[Diagnostics] Failed to export diagnostic log", error]);
    return { canceled: false, error: message };
  }
}

export function logRendererMessage(
  level: DiagnosticLogLevel,
  message: string,
  details?: unknown,
): void {
  const normalizedLevel = normalizeLogLevel(level);
  const log = console[normalizedLevel] as (...args: unknown[]) => void;
  if (details === undefined) {
    log(`[Renderer] ${message}`);
  } else {
    log(`[Renderer] ${message}`, details);
  }
}

function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  for (const method of LOG_METHODS) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    originalConsole[method] = original;
    console[method] = ((...args: unknown[]) => {
      original(...args);
      appendLogLine(method === "log" ? "info" : method, args);
    }) as typeof console[typeof method];
  }
}

function appendLogLine(level: DiagnosticLogLevel, args: unknown[]): void {
  if (!logFilePath) return;

  try {
    const line = formatLogLine(level, args);
    fs.appendFileSync(logFilePath, `${line}\n`, "utf8");
  } catch {
    // Keep diagnostics best-effort; logging must never break app behavior.
  }
}

function formatLogLine(level: DiagnosticLogLevel, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const message = util.formatWithOptions(
    { colors: false, depth: 6, maxArrayLength: 100, breakLength: 160 },
    ...args,
  );
  return `[${timestamp}] [${level.toUpperCase()}] ${redactSensitive(message)}`;
}

function redactSensitive(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(
      /\b(?:access_token|refresh_token|githubToken|codespaceToken|token)\b(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      (_match, sep: string) => `token${sep}[redacted]`,
    )
    .replace(/\b(?:gh[opsru]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, "[redacted]");
}

function rotateLogIfNeeded(currentPath: string, previousPath: string): void {
  try {
    const stat = fs.existsSync(currentPath) ? fs.statSync(currentPath) : null;
    if (!stat || stat.size < MAX_LOG_BYTES) return;
    fs.rmSync(previousPath, { force: true });
    fs.renameSync(currentPath, previousPath);
  } catch {
    // Rotation is best-effort. If it fails, appending will continue below.
  }
}

function ensureDiagnosticsInitialized(): string {
  if (logFilePath) return logFilePath;
  return initializeDiagnostics();
}

async function buildDiagnosticLogBundle(currentPath: string): Promise<string> {
  const sections: string[] = [
    [
      "Agent Maestro Desktop Diagnostic Log",
      `Generated: ${new Date().toISOString()}`,
      `App version: ${app.getVersion()}`,
      `Packaged: ${app.isPackaged}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Electron: ${process.versions.electron}`,
      `Node: ${process.versions.node}`,
      "",
    ].join("\n"),
  ];

  if (previousLogFilePath && fs.existsSync(previousLogFilePath)) {
    sections.push(await readLogSection("Previous runtime log", previousLogFilePath));
  }
  if (fs.existsSync(currentPath)) {
    sections.push(await readLogSection("Current runtime log", currentPath));
  }

  return `${sections.join("\n\n")}\n`;
}

async function readLogSection(title: string, filePath: string): Promise<string> {
  const body = await fs.promises.readFile(filePath, "utf8");
  return [`===== ${title} =====`, body.trimEnd()].join("\n");
}

function normalizeLogLevel(level: DiagnosticLogLevel): Exclude<ConsoleMethod, "log"> {
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    return level;
  }
  return "info";
}
