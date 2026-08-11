/**
 * The only data that crosses Electron's process boundary.  Keep this small:
 * titles can contain work content, so no screenshots, keystrokes, or document
 * bodies are ever part of an activity event.
 */
export type ActivityEventKind =
  | "window-focus"
  | "monitor-paused"
  | "monitor-resumed";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActivityEvent {
  id: string;
  kind: ActivityEventKind;
  timestamp: number;
  appName?: string;
  title?: string;
  processId?: number;
  windowId?: string;
  bounds?: WindowBounds;
  platform: NodeJS.Platform;
  /** True when a configured privacy rule hid the original title. */
  titleRedacted?: boolean;
}

export interface ActivityMonitorOptions {
  pollIntervalMs?: number;
  retentionMs?: number;
  /** App names or executable paths that must never be recorded. */
  excludedApps?: string[];
  /** App names or executable paths whose focus is useful but title is not. */
  redactTitleForApps?: string[];
  hereProcessId?: number;
  platform?: NodeJS.Platform;
  /** On macOS, allow get-windows to request only the OS permissions the user approved in onboarding. */
  requestPermissions?: boolean;
}

export interface ActivityStats {
  running: boolean;
  paused: boolean;
  eventCount: number;
  retentionMs: number;
  current?: ActivityEvent;
  lastCapturedAt?: number;
}

export interface ActivitySnapshot {
  current?: ActivityEvent;
  recent: ActivityEvent[];
  stats: ActivityStats;
}

export interface CausalStep {
  eventId: string;
  timestamp: number;
  label: string;
  role: "context" | "target" | "interruption" | "return";
}

export interface CausalExplanation {
  answer: string;
  origin?: string;
  nextAction?: string;
  chain: CausalStep[];
  evidenceIds: string[];
  interrupted: boolean;
}

export interface CausalQuery {
  now?: number;
  /** Defaults to the monitor's current event when omitted. */
  current?: ActivityEvent;
  events: ActivityEvent[];
}

export interface HereActivityApi {
  current(): Promise<ActivityEvent | undefined>;
  recent(since?: number): Promise<ActivityEvent[]>;
  stats(): Promise<ActivityStats>;
  pause(): Promise<ActivityStats>;
  resume(): Promise<ActivityStats>;
  explain(): Promise<CausalExplanation>;
  onEvent(listener: (event: ActivityEvent) => void): () => void;
}

export const ACTIVITY_IPC = {
  current: "here:activity:current",
  recent: "here:activity:recent",
  stats: "here:activity:stats",
  pause: "here:activity:pause",
  resume: "here:activity:resume",
  explain: "here:activity:explain",
  event: "here:activity:event",
} as const;

export type ActivityIpcChannel =
  (typeof ACTIVITY_IPC)[keyof typeof ACTIVITY_IPC];

export interface PublicSettings {
  version: 1;
  endpoint: string;
  model: string;
  captureConsent: boolean;
  shortcut: string;
  retentionMinutes: number;
  excludedApps: string[];
  showBubble: boolean;
  autoStart: boolean;
  apiKeyConfigured: boolean;
}

export type SettingsPatch = Partial<
  Pick<
    PublicSettings,
    | "endpoint"
    | "model"
    | "captureConsent"
    | "shortcut"
    | "retentionMinutes"
    | "excludedApps"
    | "showBubble"
    | "autoStart"
  >
>;

export interface SaveSettingsInput {
  settings: SettingsPatch;
  apiKey?: string;
  clearApiKey?: boolean;
}

export type RecallTrigger = "bubble" | "hotkey" | "tray" | "return" | "panel";

export interface ModelReconstruction {
  summary: string;
  target: string;
  evidenceIds: string[];
  nextAction?: string;
  source: "model" | "fallback";
}

export interface RecallState {
  status: "idle" | "loading" | "ready" | "error";
  trigger?: RecallTrigger;
  current?: ActivityEvent;
  explanation?: CausalExplanation;
  reconstruction?: ModelReconstruction;
  updatedAt: number;
  message?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export interface DesktopBootstrap {
  platform: NodeJS.Platform;
  settings: PublicSettings;
  stats: ActivityStats;
  recall: RecallState;
  shortcutRegistered: boolean;
  capturePermission:
    | "not-needed"
    | "not-determined"
    | "granted"
    | "denied"
    | "restricted"
    | "unknown";
}

export const DESKTOP_IPC = {
  bootstrap: "here:desktop:bootstrap",
  getSettings: "here:desktop:settings:get",
  saveSettings: "here:desktop:settings:save",
  testConnection: "here:desktop:connection:test",
  recall: "here:desktop:recall",
  getRecall: "here:desktop:recall:get",
  dismissRecall: "here:desktop:recall:dismiss",
  openSettings: "here:desktop:settings:open",
  closeSettings: "here:desktop:settings:close",
  clearHistory: "here:desktop:history:clear",
  pauseCapture: "here:desktop:capture:pause",
  resumeCapture: "here:desktop:capture:resume",
  setBubbleExpanded: "here:desktop:bubble:expanded",
  recallChanged: "here:desktop:recall:changed",
  settingsChanged: "here:desktop:settings:changed",
} as const;

export interface HereDesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  getSettings(): Promise<PublicSettings>;
  saveSettings(input: SaveSettingsInput): Promise<PublicSettings>;
  testConnection(input?: {
    endpoint: string;
    model: string;
    apiKey?: string;
  }): Promise<ConnectionTestResult>;
  recall(trigger?: RecallTrigger): Promise<RecallState>;
  getRecall(): Promise<RecallState>;
  dismissRecall(): Promise<void>;
  openSettings(): Promise<void>;
  closeSettings(): Promise<void>;
  clearHistory(): Promise<void>;
  pauseCapture(): Promise<ActivityStats>;
  resumeCapture(): Promise<ActivityStats>;
  setBubbleExpanded(expanded: boolean): Promise<void>;
  onRecall(listener: (state: RecallState) => void): () => void;
  onSettings(listener: (settings: PublicSettings) => void): () => void;
  onActivity(listener: (event: ActivityEvent) => void): () => void;
}
