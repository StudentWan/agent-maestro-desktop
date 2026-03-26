// src/codespace/vscode-storage-parser.ts

import type {
  DetectedCodespace,
  VscodeStorageJson,
  VscodeWindowEntry,
  CodespaceDetectionDiff,
} from "./types";

const CODESPACE_PREFIX = "codespaces+";
const FOLDER_URI_PATTERN =
  /^vscode-remote:\/\/codespaces%2B([^/]+)(\/.*)?$/;

/**
 * Safe JSON parse — returns null on failure. Never throws.
 */
export function parseStorageJson(raw: string): VscodeStorageJson | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as VscodeStorageJson;
  } catch {
    return null;
  }
}

/**
 * Parse "codespaces+fluffy-potato-abc" → "fluffy-potato-abc".
 * Returns null for non-codespace authorities.
 */
export function parseRemoteAuthority(authority: string): string | null {
  if (!authority.startsWith(CODESPACE_PREFIX)) {
    return null;
  }
  const name = authority.slice(CODESPACE_PREFIX.length);
  return name.length > 0 ? name : null;
}

/**
 * Parse "vscode-remote://codespaces%2Bfluffy-potato-abc/workspaces/repo"
 * → { name: "fluffy-potato-abc", path: "/workspaces/repo" }.
 * Returns null for non-codespace or malformed URIs.
 */
export function parseFolderUri(
  uri: string,
): { name: string; path: string } | null {
  const match = FOLDER_URI_PATTERN.exec(uri);
  if (!match) {
    return null;
  }

  const name = match[1] ?? "";
  const path = match[2] ?? "";

  if (name.length === 0 || path.length === 0) {
    return null;
  }

  return { name, path };
}

/**
 * Try to extract a DetectedCodespace from a single window entry.
 */
function windowEntryToCodespace(
  entry: VscodeWindowEntry,
  timestamp: number,
): DetectedCodespace | null {
  const folder = entry.folder ?? entry.folderUri ?? "";

  const parsed = parseFolderUri(folder);
  if (!parsed) {
    return null;
  }

  return {
    name: parsed.name,
    workspacePath: parsed.path,
    detectedAt: timestamp,
    source: "vscode-storage",
  };
}

/**
 * Extract codespace connections from storage. Deduplicates by name.
 * Looks at: windowsState.lastActiveWindow + windowsState.openedWindows
 */
export function extractCodespaces(
  storage: VscodeStorageJson,
  timestamp?: number,
): readonly DetectedCodespace[] {
  const ts = timestamp ?? Date.now();
  const windowsState = storage.windowsState;

  if (!windowsState) {
    return [];
  }

  const allEntries: readonly VscodeWindowEntry[] = [
    ...(windowsState.lastActiveWindow ? [windowsState.lastActiveWindow] : []),
    ...(windowsState.openedWindows ?? []),
  ];

  const seen = new Set<string>();
  const results: DetectedCodespace[] = [];

  for (const entry of allEntries) {
    const cs = windowEntryToCodespace(entry, ts);
    if (cs && !seen.has(cs.name)) {
      seen.add(cs.name);
      results.push(cs);
    }
  }

  return results;
}

/**
 * Compute diff between previous and current snapshots.
 */
export function diffCodespaces(
  previous: readonly DetectedCodespace[],
  current: readonly DetectedCodespace[],
): CodespaceDetectionDiff {
  const previousNames = new Set(previous.map((cs) => cs.name));
  const currentNames = new Set(current.map((cs) => cs.name));

  const opened = current.filter((cs) => !previousNames.has(cs.name));
  const closed = previous.filter((cs) => !currentNames.has(cs.name));

  return { opened, closed };
}
