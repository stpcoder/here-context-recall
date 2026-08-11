import type {
  ActivityEvent,
  ActivityMonitorOptions,
  ActivityStats,
  CaptureGapReason,
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
const DEFAULT_POLL_MS = 500;
const DEFAULT_MAX_EVENTS = 1_500;
const DEFAULT_READ_TIMEOUT_MS = 1_500;
const FAILURE_GAP_THRESHOLD = 3;
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

type WindowObservation =
  | { kind: "event"; event: ActivityEvent }
  | { kind: "self" }
  | { kind: "protected" };

/** Polls native windows; it intentionally never observes keyboard or mouse content. */
export class ActivityMonitor {
  private readonly pollIntervalMs: number;
  private readonly retentionMs: number;
  private readonly maxEvents: number;
  private readonly readTimeoutMs: number;
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
  private running = false;
  private paused = false;
  private pollPromise?: Promise<void>;
  private samplesAttempted = 0;
  private samplesObserved = 0;
  private readFailures = 0;
  private consecutiveReadFailures = 0;
  private lastPollAt?: number;
  private lastSuccessAt?: number;
  private lastErrorAt?: number;

  constructor(options: ActivityMonitorOptions = {}, reader?: WindowReader) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxEvents = Math.max(20, options.maxEvents ?? DEFAULT_MAX_EVENTS);
    this.readTimeoutMs = Math.max(
      this.pollIntervalMs,
      options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    );
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
    if (this.running) return;
    this.running = true;
    await this.poll();
    if (this.running)
      this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
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
      await this.poll();
    }
    return this.stats();
  }

  /** Forces one fresh foreground-window sample before a user-triggered recall. */
  async snapshot(): Promise<ActivityEvent | undefined> {
    const observedBefore = this.samplesObserved;
    const failuresBefore = this.readFailures;
    await this.poll();
    if (this.samplesObserved === observedBefore) {
      if (this.readFailures > failuresBefore)
        this.recordGap("unavailable", Date.now());
      return undefined;
    }
    return this.current();
  }

  current(): ActivityEvent | undefined {
    const latest = this.events.at(-1);
    return latest?.kind === "window-focus" ? latest : undefined;
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
      running: this.running,
      paused: this.paused,
      health: this.health(),
      captureMode: "polling",
      pollIntervalMs: this.pollIntervalMs,
      maxEvents: this.maxEvents,
      eventCount: this.events.length,
      retentionMs: this.retentionMs,
      samplesAttempted: this.samplesAttempted,
      samplesObserved: this.samplesObserved,
      readFailures: this.readFailures,
      consecutiveReadFailures: this.consecutiveReadFailures,
      current,
      lastCapturedAt: current?.lastSeenAt ?? current?.timestamp,
      lastPollAt: this.lastPollAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
    };
  }

  onEvent(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private poll(): Promise<void> {
    if (
      this.paused ||
      (this.platform !== "win32" && this.platform !== "darwin")
    )
      return Promise.resolve();
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.performPoll().finally(() => {
      this.pollPromise = undefined;
    });
    return this.pollPromise;
  }

  private async performPoll(): Promise<void> {
    const startedAt = Date.now();
    this.samplesAttempted += 1;
    this.lastPollAt = startedAt;
    try {
      const active = await withTimeout(
        this.getActiveWindow(),
        this.readTimeoutMs,
      );
      if (!active) {
        this.markReadFailure(startedAt);
        return;
      }
      this.samplesObserved += 1;
      this.consecutiveReadFailures = 0;
      this.lastSuccessAt = Date.now();
      let observation = this.observeWindow(active);
      // On macOS an always-on-top, non-focusable bubble can still be returned
      // as the first window. Only in that self-owned case, look directly
      // behind Here instead of mistaking an excluded/sensitive app for work.
      if (observation.kind === "self" && this.platform === "darwin") {
        const windows = await this.getOpenWindows();
        const behind = windows
          .map((window) => this.observeWindow(window))
          .find((candidate) => candidate.kind === "event");
        if (behind) observation = behind;
      }
      if (observation.kind === "self") return;
      if (observation.kind === "protected") {
        this.recordGap("protected", Date.now());
        return;
      }
      const event = observation.event;
      const latest = this.events.at(-1);
      const current = latest?.kind === "window-focus" ? latest : undefined;
      if (current && this.sameWindow(current, event)) {
        current.lastSeenAt = event.timestamp;
        current.sampleCount = (current.sampleCount ?? 1) + 1;
        if (!sameBounds(current.bounds, event.bounds)) {
          current.bounds = event.bounds;
          this.listeners.forEach((listener) => listener(current));
        }
        return;
      }
      this.record(event);
    } catch {
      // Permission denial or a transient native-window failure must not crash Here.
      this.markReadFailure(startedAt);
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

  private observeWindow(window: NativeWindow): WindowObservation {
    const appName = limited(window.owner?.name, 200) ?? "Unknown app";
    const processPath = limited(window.owner?.path ?? window.path, 1_024);
    const processId = window.owner?.processId ?? window.processId;
    const app = normalized(appName);
    if (processId === this.hereProcessId || app === "here" || app === "here.")
      return { kind: "self" };
    if (matchesRule(appName, processPath, this.excludedApps))
      return { kind: "protected" };
    const rawTitle = limited(window.title, 512);
    if (
      SENSITIVE_TITLE_PATTERNS.some((pattern) =>
        normalized(rawTitle).includes(pattern),
      )
    )
      return { kind: "protected" };
    const titleRedacted = matchesRule(
      appName,
      processPath,
      this.redactTitleForApps,
    );
    const timestamp = Date.now();
    return {
      kind: "event",
      event: {
        id: this.id(),
        kind: "window-focus",
        timestamp,
        lastSeenAt: timestamp,
        sampleCount: 1,
        appName,
        title: titleRedacted ? redactTitle(rawTitle) : rawTitle,
        processId,
        platform: this.platform,
        titleRedacted: titleRedacted || undefined,
        windowId: window.id === undefined ? undefined : String(window.id),
        bounds: normalizeBounds(window.contentBounds ?? window.bounds),
      },
    };
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
      (event) => (event.lastSeenAt ?? event.timestamp) >= cutoff,
    );
    this.events = firstKept === -1 ? [] : this.events.slice(firstKept);
    if (this.events.length > this.maxEvents)
      this.events = this.events.slice(-this.maxEvents);
  }

  private recordGap(reason: CaptureGapReason, timestamp: number): void {
    const latest = this.events.at(-1);
    if (latest?.kind === "capture-gap" && latest.gapReason === reason) {
      latest.lastSeenAt = timestamp;
      latest.sampleCount = (latest.sampleCount ?? 1) + 1;
      return;
    }
    this.record({
      id: this.id(),
      kind: "capture-gap",
      gapReason: reason,
      timestamp,
      lastSeenAt: timestamp,
      sampleCount: 1,
      platform: this.platform,
    });
  }

  private markReadFailure(at: number): void {
    this.readFailures += 1;
    this.consecutiveReadFailures += 1;
    this.lastErrorAt = at;
    if (this.consecutiveReadFailures === FAILURE_GAP_THRESHOLD)
      this.recordGap("unavailable", at);
  }

  private health(): ActivityStats["health"] {
    if (!this.running) return "stopped";
    if (this.paused) return "paused";
    const staleAfter = Math.max(5_000, this.pollIntervalMs * 6);
    if (
      this.consecutiveReadFailures >= FAILURE_GAP_THRESHOLD ||
      (this.lastSuccessAt !== undefined &&
        Date.now() - this.lastSuccessAt > staleAfter)
    )
      return "degraded";
    return "healthy";
  }

  private id(): string {
    return `activity_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Window reader timed out.");
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
