import { EventEmitter } from "node:events";
import {
  CODESPACE_LIST_CACHE_MS,
  VSCODE_DETECTOR_POLL_INTERVAL_MS,
} from "../shared/constants";
import { listProcesses as defaultListProcesses, type ProcessInfo } from "./process-list";
import {
  listWindowTitles as defaultListWindowTitles,
  extractCodespaceDisplayNameFromTitle,
} from "./window-titles";
import { listCodespaces as defaultListCodespaces } from "./gh-cli";
import type { CodespaceInfo } from "./types";

export interface VsCodeCodespaceDetectorOptions {
  intervalMs?: number;
  listProcesses?: () => Promise<ProcessInfo[]>;
  listWindowTitles?: () => Promise<string[]>;
  /**
   * If provided, takes precedence over `getToken` — passes a fully-resolved
   * codespace list (used in tests).
   */
  listCodespaces?: () => Promise<CodespaceInfo[]>;
  /**
   * Returns the current GitHub token to inject into `gh api /user/codespaces`
   * via GH_TOKEN. Lets the detector keep working after token rotation
   * without being re-instantiated.
   */
  getToken?: () => string | undefined;
  /**
   * PIDs to exclude from the process scan. Prevents the detector from
   * "discovering" our own SSH tunnel processes and keeping the auto-bridge
   * alive after the user has closed VS Code.
   */
  getExcludePids?: () => ReadonlySet<number>;
  codespaceListCacheMs?: number;
  now?: () => number;
}

const NAME_RE = /[A-Za-z0-9][A-Za-z0-9-]{2,}/;

/**
 * Try every known shape used by VS Code / gh CLI to ssh into a Codespace
 * and yield candidate names. Names are validated later against gh cs list.
 *
 * NOTE: Modern VS Code Codespaces extension does NOT expose the codespace
 * name in any external process command line — it tunnels via an in-extension
 * Node.js library. So this fallback rarely helps, but we keep it for older
 * extension versions and gh CLI users.
 */
export function extractCandidateNames(command: string): string[] {
  const out: string[] = [];

  const flag = /--codespace[= ]([A-Za-z0-9][A-Za-z0-9-]{2,})/g;
  for (let m: RegExpExecArray | null; (m = flag.exec(command)); ) {
    out.push(m[1]);
  }

  if (/\bgh\b.*\b(codespace|cs)\b.*\bssh\b/.test(command)) {
    const short = /\s-c\s+([A-Za-z0-9][A-Za-z0-9-]{2,})/g;
    for (let m: RegExpExecArray | null; (m = short.exec(command)); ) {
      out.push(m[1]);
    }
  }

  const sshHost =
    /([A-Za-z0-9][A-Za-z0-9-]{2,})@(?:[A-Za-z0-9-]+\.)?(?:ssh\.codespaces\.dev|codespaces\.dev|codespaces\.github\.dev|codespaces\.[A-Za-z0-9.-]+)/g;
  for (let m: RegExpExecArray | null; (m = sshHost.exec(command)); ) {
    out.push(m[1]);
  }

  if (/codespaces?/i.test(command)) {
    const tokenRe = /([A-Za-z][A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,})/g;
    for (let m: RegExpExecArray | null; (m = tokenRe.exec(command)); ) {
      const candidate = m[1];
      if (candidate.length >= 12 && NAME_RE.test(candidate)) {
        out.push(candidate);
      }
    }
  }

  return Array.from(new Set(out));
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Normalize a name/displayName for forgiving matching. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export class VsCodeCodespaceDetector extends EventEmitter {
  private readonly intervalMs: number;
  private readonly cacheMs: number;
  private readonly listProcessesFn: () => Promise<ProcessInfo[]>;
  private readonly listWindowTitlesFn: () => Promise<string[]>;
  private readonly listCodespacesFn: () => Promise<CodespaceInfo[]>;
  private readonly getExcludePidsFn: () => ReadonlySet<number>;
  private readonly nowFn: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private current: Map<string, CodespaceInfo> = new Map();
  private codespaceCache: { fetchedAt: number; value: CodespaceInfo[] } | null = null;
  private inFlight = false;

  constructor(options: VsCodeCodespaceDetectorOptions = {}) {
    super();
    this.intervalMs = options.intervalMs ?? VSCODE_DETECTOR_POLL_INTERVAL_MS;
    this.cacheMs = options.codespaceListCacheMs ?? CODESPACE_LIST_CACHE_MS;
    this.listProcessesFn = options.listProcesses ?? (() => defaultListProcesses());
    this.listWindowTitlesFn =
      options.listWindowTitles ?? (() => defaultListWindowTitles());
    this.listCodespacesFn =
      options.listCodespaces ??
      (() => defaultListCodespaces(options.getToken?.()));
    this.getExcludePidsFn = options.getExcludePids ?? (() => new Set());
    this.nowFn = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getCurrent(): ReadonlyMap<string, CodespaceInfo> {
    return new Map(this.current);
  }

  /**
   * Force the next call to `getCodespaces()` to bypass the cache and re-hit
   * `gh cs list`. Use this when an external signal (e.g., an SSH tunnel
   * unexpectedly dying) makes us suspect the cached state is stale —
   * waiting up to `cacheMs` for the truth to surface causes user-visible
   * lag (codespace stays "connected" in the UI for ~30s after stop).
   */
  invalidateCache(): void {
    this.codespaceCache = null;
  }

  /** Force a single detection pass. Public for tests and orchestrator startup. */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      // Primary: window titles (works for VS Code Codespaces extension).
      // Capture failure separately from "no titles": a PowerShell hiccup
      // returning [] while VS Code is actually open with a Codespace would
      // otherwise look identical to "user closed VS Code", and the
      // auto-bridge would happily disconnect a healthy connection.
      const titlesResult = await this.safeListWindowTitlesResult();
      const titleCandidates = new Set<string>();
      for (const title of titlesResult.titles) {
        const name = extractCodespaceDisplayNameFromTitle(title);
        if (name) titleCandidates.add(name);
      }

      // Fallback: process command lines (works for `gh cs ssh` and older flows).
      // Exclude our own SSH tunnel PIDs — otherwise we'd "discover" our own
      // tunnels and keep the auto-bridge alive even after the user closes
      // VS Code.
      const excludePids = this.getExcludePidsFn();
      const processesResult = await this.safeListProcessesResult();
      const cmdCandidates = new Set<string>();
      for (const p of processesResult.processes) {
        if (excludePids.has(p.pid)) continue;
        for (const name of extractCandidateNames(p.command)) {
          cmdCandidates.add(name);
        }
      }

      // If BOTH enumeration sources failed, we have no information about
      // what's really running. Holding the previous state is much safer
      // than emitting "" and letting auto-bridge tear down good connections.
      if (titlesResult.failed && processesResult.failed) {
        console.warn(
          `[${new Date().toISOString()}] [VsCodeCodespaceDetector] both window-title and process enumeration failed this tick — holding previous state (had ${this.current.size} entries) to avoid spurious disconnects`,
        );
        return;
      }

      const allCandidates = new Set<string>([...titleCandidates, ...cmdCandidates]);
      if (allCandidates.size === 0) {
        // Genuinely nothing detected — emit empty to drive grace timers.
        // But if exactly one source failed AND the other is empty, that's
        // also ambiguous: hold previous state instead of emitting empty,
        // because a single failed source can hide the real candidates.
        if ((titlesResult.failed || processesResult.failed) && this.current.size > 0) {
          console.warn(
            `[${new Date().toISOString()}] [VsCodeCodespaceDetector] one enumeration source failed and the other returned empty — holding previous state (${this.current.size} entries) to avoid spurious disconnects`,
          );
          return;
        }
        this.maybeEmit(new Map());
        return;
      }

      const codespaces = await this.getCodespaces();

      // Build a forgiving lookup: by exact API name, normalized API name,
      // and normalized displayName.
      const lookup = new Map<string, CodespaceInfo>();
      for (const cs of codespaces) {
        lookup.set(cs.name, cs);
        lookup.set(normalize(cs.name), cs);
        if (cs.displayName) lookup.set(normalize(cs.displayName), cs);
      }

      const next = new Map<string, CodespaceInfo>();
      for (const candidate of allCandidates) {
        const direct = lookup.get(candidate) ?? lookup.get(normalize(candidate));
        if (direct) {
          // Filter out codespaces that aren't actually running. VS Code keeps
          // the window (and its `[Codespaces: …]` title) open even after the
          // user stops the codespace, so the title alone can't tell us if
          // the tunnel target is still alive. `gh cs list` is authoritative
          // here — only "Available" means SSH will succeed.
          //
          // Treating Shutdown/Starting/Provisioning/etc. as "not present"
          // lets the auto-bridge schedule its grace-period disconnect, which
          // is the behavior the user expects when they hit "Stop codespace".
          if (direct.state !== "Available") continue;
          next.set(direct.name, direct);
          continue;
        }
        // No gh cs list match. If the candidate came from a window title we
        // still surface it as a synthetic entry so the user can see what was
        // detected (e.g. when the user's gh token lacks the codespace scope
        // and listCodespaces returned []). Connection attempts may fail
        // downstream, but the UI tells the truth about detection.
        if (titleCandidates.has(candidate) && codespaces.length === 0) {
          const synthetic: CodespaceInfo = {
            id: 0,
            name: candidate,
            displayName: candidate,
            repository: "",
            state: "Available",
            machine: "unknown",
            lastUsedAt: new Date().toISOString(),
          };
          next.set(candidate, synthetic);
        }
      }
      this.maybeEmit(next);
    } catch (err) {
      console.warn("[VsCodeCodespaceDetector] tick failed:", err);
    } finally {
      this.inFlight = false;
    }
  }

  private maybeEmit(next: Map<string, CodespaceInfo>): void {
    const prevKeys = new Set(this.current.keys());
    const nextKeys = new Set(next.keys());
    if (setsEqual(prevKeys, nextKeys)) {
      this.current = next;
      return;
    }
    this.current = next;
    this.emit("changed", new Map(next));
  }

  private async safeListProcesses(): Promise<ProcessInfo[]> {
    try {
      return await this.listProcessesFn();
    } catch (err) {
      console.warn("[VsCodeCodespaceDetector] listProcesses failed:", err);
      return [];
    }
  }

  private async safeListWindowTitles(): Promise<string[]> {
    try {
      return await this.listWindowTitlesFn();
    } catch (err) {
      console.warn("[VsCodeCodespaceDetector] listWindowTitles failed:", err);
      return [];
    }
  }

  /**
   * Like safeListProcesses but reports whether the underlying call threw.
   * Used by tick() to distinguish "successfully observed empty" from
   * "couldn't observe at all" — only the former is a real signal that
   * VS Code is gone.
   */
  private async safeListProcessesResult(): Promise<{ processes: ProcessInfo[]; failed: boolean }> {
    try {
      return { processes: await this.listProcessesFn(), failed: false };
    } catch (err) {
      console.warn(
        `[${new Date().toISOString()}] [VsCodeCodespaceDetector] listProcesses failed:`,
        err,
      );
      return { processes: [], failed: true };
    }
  }

  private async safeListWindowTitlesResult(): Promise<{ titles: string[]; failed: boolean }> {
    try {
      return { titles: await this.listWindowTitlesFn(), failed: false };
    } catch (err) {
      console.warn(
        `[${new Date().toISOString()}] [VsCodeCodespaceDetector] listWindowTitles failed:`,
        err,
      );
      return { titles: [], failed: true };
    }
  }

  private async getCodespaces(): Promise<CodespaceInfo[]> {
    const now = this.nowFn();
    if (this.codespaceCache && now - this.codespaceCache.fetchedAt < this.cacheMs) {
      return this.codespaceCache.value;
    }
    try {
      const value = await this.listCodespacesFn();
      this.codespaceCache = { fetchedAt: now, value };
      return value;
    } catch (err) {
      console.warn("[VsCodeCodespaceDetector] listCodespaces failed:", err);
      return this.codespaceCache?.value ?? [];
    }
  }
}
