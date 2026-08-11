import type {
  ActivityEvent,
  ActivityMonitorOptions,
  ActivityStats,
} from "../shared/contracts";

type WindowOwner = { name?: string; path?: string; processId?: number };
export type NativeWindow = {
  id?: number | string;
  title?: string;
  owner?: WindowOwner;
  processId?: number;
  path?: string;
  isActive?: boolean;
  active?: boolean;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  contentBounds?: { x?: number; y?: number; width?: number; height?: number };
};

export type WindowReader = {
  activeWindow?: (
    options?: Record<string, unknown>,
  ) => Promise<NativeWindow | undefined>;
  openWindows?: (options?: Record<string, unknown>) => Promise<NativeWindow[]>;
  // Kept for injected test readers from earlier builds.
  getActiveWindow?: () => Promise<NativeWindow | undefined>;
  getWindows?: () => Promise<NativeWindow[]>;
};

export const DEFAULT_EXCLUDED_APPS = [
  "1password",
  "bitwarden",
  "lastpass",
  "keepass",
  "dashlane",
  "nordpass",
  "proton pass",
  "keeper password manager",
  "credential manager",
  "windows security",
];
// Consent covers active-app and window-title collection. Do not blanket-redact
// communication app titles: that would remove the only useful causal signal.
// Password managers and credential surfaces are excluded above; users can add
// any additional app/path exclusions in Settings.
export const DEFAULT_REDACT_TITLE_APPS: string[] = [];

const DEFAULT_RETENTION_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_MS = 1_000;
const SENSITIVE_TITLE_PATTERNS = [
  "incognito",
  "inprivate",
  "private browsing",
  "private window",
  "시크릿 모드",
  "시크릿 창",
];

function limited(value: string | undefined, max: number): string | undefined {
  const result = value?.trim();
  return result ? result.slice(0, max) : undefined;
}

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function matchesRule(
  app: string,
  processPath: string | undefined,
  rules: readonly string[],
): boolean {
  const haystack = `${app}\n${processPath ?? ""}`.toLocaleLowerCase();
  return rules.some(
    (rule) => rule.trim() && haystack.includes(rule.trim().toLocaleLowerCase()),
  );
}

function redactTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  return "[Title hidden]";
}

/** Polls native windows; it intentionally never observes keyboard or mouse content. */
export class ActivityMonitor {
  private readonly pollIntervalMs: number;
  private readonly retentionMs: number;
  private readonly excludedApps: string[];
  private readonly redactTitleForApps: string[];
  private readonly hereProcessId: number;
  private readonly platform: NodeJS.Platform;
  private readonly requestPermissions: boolean;
  private readonly listeners = new Set<(event: ActivityEvent) => void>();
  private readonly reader?: WindowReader;
  private loadedReader?: WindowReader;
  private events: ActivityEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private paused = false;
  private polling = false;

  constructor(options: ActivityMonitorOptions = {}, reader?: WindowReader) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.excludedApps = [
      ...DEFAULT_EXCLUDED_APPS,
      ...(options.excludedApps ?? []),
    ];
    this.redactTitleForApps = [
      ...DEFAULT_REDACT_TITLE_APPS,
      ...(options.redactTitleForApps ?? []),
    ];
    this.hereProcessId = options.hereProcessId ?? process.pid;
    this.platform = options.platform ?? process.platform;
    this.requestPermissions = options.requestPermissions ?? false;
    this.reader = reader;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async pause(): Promise<ActivityStats> {
    if (!this.paused) {
      this.paused = true;
      this.record({
        id: this.id(),
        kind: "monitor-paused",
        timestamp: Date.now(),
        platform: this.platform,
      });
    }
    return this.stats();
  }

  async resume(): Promise<ActivityStats> {
    if (this.paused) {
      this.paused = false;
      this.record({
        id: this.id(),
        kind: "monitor-resumed",
        timestamp: Date.now(),
        platform: this.platform,
      });
    }
    return this.stats();
  }

  current(): ActivityEvent | undefined {
    return [...this.events]
      .reverse()
      .find((event) => event.kind === "window-focus");
  }

  recent(since = Date.now() - this.retentionMs): ActivityEvent[] {
    this.prune(Date.now());
    return this.events.filter((event) => event.timestamp >= since);
  }

  clear(): void {
    this.events = [];
  }

  stats(): ActivityStats {
    this.prune(Date.now());
    const current = this.current();
    return {
      running: Boolean(this.timer),
      paused: this.paused,
      eventCount: this.events.length,
      retentionMs: this.retentionMs,
      current,
      lastCapturedAt: current?.timestamp,
    };
  }

  onEvent(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async poll(): Promise<void> {
    if (
      this.paused ||
      this.polling ||
      (this.platform !== "win32" && this.platform !== "darwin")
    )
      return;
    this.polling = true;
    try {
      const active = await this.getActiveWindow();
      if (!active) return;
      let event = this.toEvent(active);
      // On macOS an always-on-top, non-focusable bubble can still be returned
      // as the first window. Only in that self-owned case, look directly
      // behind Here instead of mistaking an excluded/sensitive app for work.
      if (!event && this.isHereWindow(active)) {
        const windows = await this.getOpenWindows();
        event = windows.map((window) => this.toEvent(window)).find(Boolean);
      }
      if (!event) return;
      const current = this.current();
      if (current && this.sameWindow(current, event)) {
        if (!sameBounds(current.bounds, event.bounds)) {
          current.bounds = event.bounds;
          this.listeners.forEach((listener) => listener(current));
        }
        return;
      }
      this.record(event);
    } catch {
      // Permission denial or a transient native-window failure must not crash Here.
    } finally {
      this.polling = false;
    }
  }

  private async getActiveWindow(): Promise<NativeWindow | undefined> {
    const reader =
      this.reader ?? this.loadedReader ?? (await this.loadReader());
    this.loadedReader ??= reader;
    if (reader.activeWindow) {
      return reader.activeWindow(
        this.platform === "darwin"
          ? {
              accessibilityPermission: this.requestPermissions,
              screenRecordingPermission: this.requestPermissions,
            }
          : undefined,
      );
    }
    if (reader.getActiveWindow) return reader.getActiveWindow();
    const windows = await this.getOpenWindows(reader);
    return (
      windows.find((window) => window.isActive || window.active) ?? windows[0]
    );
  }

  private async getOpenWindows(
    readerOverride?: WindowReader,
  ): Promise<NativeWindow[]> {
    const reader =
      readerOverride ??
      this.reader ??
      this.loadedReader ??
      (await this.loadReader());
    this.loadedReader ??= reader;
    const permissions =
      this.platform === "darwin"
        ? {
            accessibilityPermission: this.requestPermissions,
            screenRecordingPermission: this.requestPermissions,
          }
        : undefined;
    return reader.openWindows?.(permissions) ?? reader.getWindows?.() ?? [];
  }

  private async loadReader(): Promise<WindowReader> {
    // Avoid making development/startup fail on platforms where get-windows is optional.
    const load = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<WindowReader>;
    return load("get-windows");
  }

  private toEvent(window: NativeWindow): ActivityEvent | undefined {
    const appName = limited(window.owner?.name, 200) ?? "Unknown app";
    const processPath = limited(window.owner?.path ?? window.path, 1_024);
    const processId = window.owner?.processId ?? window.processId;
    const app = normalized(appName);
    if (
      processId === this.hereProcessId ||
      app === "here" ||
      app === "here." ||
      matchesRule(appName, processPath, this.excludedApps)
    )
      return undefined;
    const rawTitle = limited(window.title, 512);
    if (
      SENSITIVE_TITLE_PATTERNS.some((pattern) =>
        normalized(rawTitle).includes(pattern),
      )
    )
      return undefined;
    const titleRedacted = matchesRule(
      appName,
      processPath,
      this.redactTitleForApps,
    );
    return {
      id: this.id(),
      kind: "window-focus",
      timestamp: Date.now(),
      appName,
      title: titleRedacted ? redactTitle(rawTitle) : rawTitle,
      processId,
      platform: this.platform,
      titleRedacted: titleRedacted || undefined,
      windowId: window.id === undefined ? undefined : String(window.id),
      bounds: normalizeBounds(window.contentBounds ?? window.bounds),
    };
  }

  private isHereWindow(window: NativeWindow): boolean {
    const appName = normalized(window.owner?.name);
    const processId = window.owner?.processId ?? window.processId;
    return (
      processId === this.hereProcessId ||
      appName === "here" ||
      appName === "here."
    );
  }

  private sameWindow(left: ActivityEvent, right: ActivityEvent): boolean {
    return (
      left.windowId === right.windowId &&
      left.processId === right.processId &&
      left.appName === right.appName &&
      left.title === right.title
    );
  }

  private record(event: ActivityEvent): void {
    this.events.push(event);
    this.prune(event.timestamp);
    this.listeners.forEach((listener) => listener(event));
  }

  private prune(now: number): void {
    const cutoff = now - this.retentionMs;
    const firstKept = this.events.findIndex(
      (event) => event.timestamp >= cutoff,
    );
    this.events = firstKept === -1 ? [] : this.events.slice(firstKept);
  }

  private id(): string {
    return `activity_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function normalizeBounds(
  value: NativeWindow["bounds"],
): ActivityEvent["bounds"] {
  if (
    !value ||
    ![value.x, value.y, value.width, value.height].every(Number.isFinite)
  )
    return undefined;
  if ((value.width ?? 0) <= 0 || (value.height ?? 0) <= 0) return undefined;
  return {
    x: value.x!,
    y: value.y!,
    width: value.width!,
    height: value.height!,
  };
}

function sameBounds(
  left: ActivityEvent["bounds"],
  right: ActivityEvent["bounds"],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
