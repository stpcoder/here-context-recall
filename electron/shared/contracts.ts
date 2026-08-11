/**
 * The only data that crosses Electron's process boundary.  Keep this small:
 * titles can contain work content, so screenshots, keystrokes, and document
 * bodies are never part of the background activity stream. A screenshot can
 * cross separately only after an explicit remember/recall action and opt-in.
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
  modelProvider: ModelProvider;
  endpoint: string;
  model: string;
  vertexProject: string;
  vertexLocation: string;
  includeWindowImage: boolean;
  captureConsent: boolean;
  shortcut: string;
  checkpointShortcut: string;
  retentionMinutes: number;
  excludedApps: string[];
  showBubble: boolean;
  autoStart: boolean;
  apiKeyConfigured: boolean;
}

export type SettingsPatch = Partial<
  Pick<
    PublicSettings,
    | "modelProvider"
    | "endpoint"
    | "model"
    | "vertexProject"
    | "vertexLocation"
    | "includeWindowImage"
    | "captureConsent"
    | "shortcut"
    | "checkpointShortcut"
    | "retentionMinutes"
    | "excludedApps"
    | "showBubble"
    | "autoStart"
  >
>;

export type ModelProvider = "openai-compatible" | "vertex-gcloud";

export interface SaveSettingsInput {
  settings: SettingsPatch;
  apiKey?: string;
  clearApiKey?: boolean;
}

export type RecallTrigger =
  | "bubble"
  | "hotkey"
  | "tray"
  | "return"
  | "panel"
  | "saved";

export interface CheckpointImage {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  dataUrl: string;
  width: number;
  height: number;
}

export interface ContextCheckpoint {
  id: string;
  createdAt: number;
  event?: ActivityEvent;
  evidence: ActivityEvent[];
  explanation?: CausalExplanation;
  reconstruction?: ModelReconstruction;
  image?: CheckpointImage;
}

export interface CheckpointState {
  status: "idle" | "saving" | "saved" | "error";
  updatedAt: number;
  count: number;
  latest?: ContextCheckpoint;
  message?: string;
}

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
  checkpoint?: ContextCheckpoint;
  mode?: "recent" | "checkpoint";
  contextImage?: CheckpointImage;
  updatedAt: number;
  message?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  models: string[];
  selectedModel?: string;
  /** True only after the selected model answered a real chat-completions call. */
  chatCompletionVerified?: boolean;
  /** True only after the response passed Here's grounded reconstruction schema. */
  reconstructionVerified?: boolean;
  structuredOutputMode?: "json-schema" | "json-object" | "prompt-only";
  visionRequested?: boolean;
  visionVerified?: boolean;
  /** `/models` is useful discovery, but is not required by every internal gateway. */
  modelsEndpointAvailable?: boolean;
  latencyMs?: number;
  requestId?: string;
  warning?: string;
  error?: string;
}

export interface DesktopBootstrap {
  platform: NodeJS.Platform;
  settings: PublicSettings;
  stats: ActivityStats;
  recall: RecallState;
  checkpoint: CheckpointState;
  shortcutRegistered: boolean;
  checkpointShortcutRegistered: boolean;
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
  clearCheckpoints: "here:desktop:checkpoint:clear",
  remember: "here:desktop:checkpoint:remember",
  pauseCapture: "here:desktop:capture:pause",
  resumeCapture: "here:desktop:capture:resume",
  setBubbleExpanded: "here:desktop:bubble:expanded",
  recallChanged: "here:desktop:recall:changed",
  settingsChanged: "here:desktop:settings:changed",
  checkpointChanged: "here:desktop:checkpoint:changed",
} as const;

export interface HereDesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  getSettings(): Promise<PublicSettings>;
  saveSettings(input: SaveSettingsInput): Promise<PublicSettings>;
  testConnection(input?: {
    modelProvider: ModelProvider;
    endpoint: string;
    model: string;
    vertexProject: string;
    vertexLocation: string;
    apiKey?: string;
    testVision?: boolean;
  }): Promise<ConnectionTestResult>;
  recall(trigger?: RecallTrigger): Promise<RecallState>;
  getRecall(): Promise<RecallState>;
  dismissRecall(): Promise<void>;
  openSettings(): Promise<void>;
  closeSettings(): Promise<void>;
  clearHistory(): Promise<void>;
  clearCheckpoints(): Promise<CheckpointState>;
  remember(): Promise<CheckpointState>;
  pauseCapture(): Promise<ActivityStats>;
  resumeCapture(): Promise<ActivityStats>;
  setBubbleExpanded(expanded: boolean): Promise<void>;
  onRecall(listener: (state: RecallState) => void): () => void;
  onSettings(listener: (settings: PublicSettings) => void): () => void;
  onCheckpoint(listener: (state: CheckpointState) => void): () => void;
  onActivity(listener: (event: ActivityEvent) => void): () => void;
}
