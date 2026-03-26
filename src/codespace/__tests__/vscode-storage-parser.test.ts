import { describe, it, expect } from "vitest";
import {
  parseStorageJson,
  parseRemoteAuthority,
  parseFolderUri,
  extractCodespaces,
  diffCodespaces,
} from "../vscode-storage-parser";

import type { DetectedCodespace } from "../types";

import singleCodespace from "../__fixtures__/storage-single-codespace.json";
import multipleCodespaces from "../__fixtures__/storage-multiple-codespaces.json";
import noCodespaces from "../__fixtures__/storage-no-codespaces.json";
import mixedRemoteTypes from "../__fixtures__/storage-mixed-remote-types.json";

// ── parseStorageJson ──────────────────────────────────────────────

describe("parseStorageJson", () => {
  it("parses valid JSON with windowsState", () => {
    const raw = JSON.stringify(singleCodespace);
    const result = parseStorageJson(raw);

    expect(result).not.toBeNull();
    expect(result?.windowsState).toBeDefined();
    expect(result?.windowsState?.lastActiveWindow?.remoteAuthority).toBe(
      "codespaces+fluffy-potato-abc123",
    );
  });

  it("returns null for invalid JSON", () => {
    expect(parseStorageJson("{not valid json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseStorageJson("")).toBeNull();
  });

  it("parses JSON without windowsState (valid but empty)", () => {
    const result = parseStorageJson("{}");

    expect(result).not.toBeNull();
    expect(result?.windowsState).toBeUndefined();
  });
});

// ── parseRemoteAuthority ──────────────────────────────────────────

describe("parseRemoteAuthority", () => {
  it('parses "codespaces+fluffy-potato-abc123" → "fluffy-potato-abc123"', () => {
    expect(parseRemoteAuthority("codespaces+fluffy-potato-abc123")).toBe(
      "fluffy-potato-abc123",
    );
  });

  it('returns null for "ssh-remote+my-server"', () => {
    expect(parseRemoteAuthority("ssh-remote+my-server")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRemoteAuthority("")).toBeNull();
  });

  it('returns null for "codespaces" (no + separator)', () => {
    expect(parseRemoteAuthority("codespaces")).toBeNull();
  });
});

// ── parseFolderUri ────────────────────────────────────────────────

describe("parseFolderUri", () => {
  it("parses standard codespace URI with %2B encoding", () => {
    const uri =
      "vscode-remote://codespaces%2Bfluffy-potato-abc123/workspaces/my-repo";
    const result = parseFolderUri(uri);

    expect(result).toEqual({
      name: "fluffy-potato-abc123",
      path: "/workspaces/my-repo",
    });
  });

  it("returns null for local file URI", () => {
    expect(
      parseFolderUri("file:///home/user/projects/local-project"),
    ).toBeNull();
  });

  it("returns null for SSH remote URI", () => {
    expect(
      parseFolderUri(
        "vscode-remote://ssh-remote+my-server/home/user/project",
      ),
    ).toBeNull();
  });

  it("extracts workspace path correctly", () => {
    const uri =
      "vscode-remote://codespaces%2Bcurly-umbrella-xyz789/workspaces/repo2";
    const result = parseFolderUri(uri);

    expect(result).toEqual({
      name: "curly-umbrella-xyz789",
      path: "/workspaces/repo2",
    });
  });

  it("returns null for malformed URI", () => {
    expect(parseFolderUri("not-a-uri")).toBeNull();
    expect(parseFolderUri("")).toBeNull();
    expect(parseFolderUri("vscode-remote://codespaces%2B")).toBeNull();
  });
});

// ── extractCodespaces ─────────────────────────────────────────────

describe("extractCodespaces", () => {
  const FIXED_TS = 1700000000000;

  it("extracts single codespace from lastActiveWindow", () => {
    const result = extractCodespaces(singleCodespace, FIXED_TS);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "fluffy-potato-abc123",
      workspacePath: "/workspaces/my-repo",
      detectedAt: FIXED_TS,
      source: "vscode-storage",
    });
  });

  it("extracts multiple codespaces from lastActiveWindow + openedWindows", () => {
    const result = extractCodespaces(multipleCodespaces, FIXED_TS);

    expect(result).toHaveLength(2);

    const names = result.map((cs) => cs.name);
    expect(names).toContain("fluffy-potato-abc123");
    expect(names).toContain("curly-umbrella-xyz789");
  });

  it("returns empty array for no codespaces", () => {
    const result = extractCodespaces(noCodespaces, FIXED_TS);

    expect(result).toEqual([]);
  });

  it("deduplicates when same codespace in lastActiveWindow and openedWindows", () => {
    const duplicateStorage = {
      windowsState: {
        lastActiveWindow: {
          folder:
            "vscode-remote://codespaces%2Bfluffy-potato-abc123/workspaces/repo",
          remoteAuthority: "codespaces+fluffy-potato-abc123",
        },
        openedWindows: [
          {
            folder:
              "vscode-remote://codespaces%2Bfluffy-potato-abc123/workspaces/repo",
            remoteAuthority: "codespaces+fluffy-potato-abc123",
          },
        ],
      },
    };

    const result = extractCodespaces(duplicateStorage, FIXED_TS);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("fluffy-potato-abc123");
  });

  it("filters out non-codespace remote types (SSH, dev container)", () => {
    const result = extractCodespaces(mixedRemoteTypes, FIXED_TS);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("fluffy-potato-abc123");
  });

  it("handles missing/undefined fields gracefully", () => {
    expect(extractCodespaces({}, FIXED_TS)).toEqual([]);
    expect(extractCodespaces({ windowsState: {} }, FIXED_TS)).toEqual([]);
    expect(
      extractCodespaces(
        { windowsState: { openedWindows: [] } },
        FIXED_TS,
      ),
    ).toEqual([]);
    expect(
      extractCodespaces(
        { windowsState: { lastActiveWindow: {} } },
        FIXED_TS,
      ),
    ).toEqual([]);
  });
});

// ── diffCodespaces ────────────────────────────────────────────────

describe("diffCodespaces", () => {
  const mkCs = (name: string): DetectedCodespace => ({
    name,
    workspacePath: `/workspaces/${name}`,
    detectedAt: 1700000000000,
    source: "vscode-storage",
  });

  it("detects newly opened codespace", () => {
    const previous: readonly DetectedCodespace[] = [];
    const current: readonly DetectedCodespace[] = [mkCs("new-cs")];

    const diff = diffCodespaces(previous, current);

    expect(diff.opened).toEqual([mkCs("new-cs")]);
    expect(diff.closed).toEqual([]);
  });

  it("detects closed codespace", () => {
    const previous: readonly DetectedCodespace[] = [mkCs("old-cs")];
    const current: readonly DetectedCodespace[] = [];

    const diff = diffCodespaces(previous, current);

    expect(diff.opened).toEqual([]);
    expect(diff.closed).toEqual([mkCs("old-cs")]);
  });

  it("reports no changes when snapshots are identical", () => {
    const snapshot: readonly DetectedCodespace[] = [
      mkCs("cs-a"),
      mkCs("cs-b"),
    ];

    const diff = diffCodespaces(snapshot, snapshot);

    expect(diff.opened).toEqual([]);
    expect(diff.closed).toEqual([]);
  });

  it("handles mixed open/close changes", () => {
    const previous: readonly DetectedCodespace[] = [
      mkCs("cs-a"),
      mkCs("cs-b"),
    ];
    const current: readonly DetectedCodespace[] = [
      mkCs("cs-b"),
      mkCs("cs-c"),
    ];

    const diff = diffCodespaces(previous, current);

    expect(diff.opened).toEqual([mkCs("cs-c")]);
    expect(diff.closed).toEqual([mkCs("cs-a")]);
  });

  it("handles empty arrays", () => {
    const diff = diffCodespaces([], []);

    expect(diff.opened).toEqual([]);
    expect(diff.closed).toEqual([]);
  });
});
