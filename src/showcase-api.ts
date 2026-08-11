import type {
  ActivityEvent,
  ActivityStats,
  CheckpointState,
  ContextCheckpoint,
  DesktopBootstrap,
  HereDesktopApi,
  PublicSettings,
  RecallState,
} from "../electron/shared/contracts";

/**
 * Development-only, non-sensitive fixture for repeatable product screenshots.
 * Electron always provides the real preload bridge, so this is used only at
 * `?showcase=1` in a Vite development browser.
 */
export function createShowcaseApi(): HereDesktopApi {
  const at = (minute: number) =>
    new Date(`2026-08-11T05:${String(minute).padStart(2, "0")}:00Z`).getTime();
  const event = (
    id: string,
    minute: number,
    appName: string,
    title: string,
  ): ActivityEvent => ({
    id,
    kind: "window-focus",
    timestamp: at(minute),
    appName,
    title,
    platform: "darwin",
  });
  const events = [
    event("msg", 31, "Slack", "김OO · A sample 결과 확인 가능?"),
    event("folder", 32, "Finder", "평가 결과"),
    event("sheet", 33, "Microsoft Excel", "result_0723.xlsx"),
    event("mail", 34, "Microsoft Outlook", "분기 예산 승인 요청"),
    event("return", 36, "Microsoft Excel", "result_0723.xlsx"),
  ];
  const explanation = {
    answer: "A sample 결과를 확인하려고 result_0723.xlsx로 돌아왔어요.",
    origin: "Slack — 김OO · A sample 결과 확인 가능?",
    nextAction: "Sample A / Condition B 확인 계속하기",
    interrupted: true,
    evidenceIds: events.map(({ id }) => id),
    chain: [
      {
        eventId: "msg",
        timestamp: events[0].timestamp,
        label: "Slack — 김OO · A sample 결과 확인 가능?",
        role: "context" as const,
      },
      {
        eventId: "folder",
        timestamp: events[1].timestamp,
        label: "Finder — 평가 결과",
        role: "context" as const,
      },
      {
        eventId: "sheet",
        timestamp: events[2].timestamp,
        label: "Microsoft Excel — result_0723.xlsx",
        role: "context" as const,
      },
      {
        eventId: "mail",
        timestamp: events[3].timestamp,
        label: "Microsoft Outlook — 분기 예산 승인 요청",
        role: "interruption" as const,
      },
      {
        eventId: "return",
        timestamp: events[4].timestamp,
        label: "Microsoft Excel — result_0723.xlsx",
        role: "return" as const,
      },
    ],
  };
  const settings: PublicSettings = {
    version: 1,
    modelProvider: "openai-compatible",
    endpoint: "https://llm.company.internal/v1",
    model: "Qwen/Qwen2.5-72B-Instruct",
    vertexProject: "",
    vertexLocation: "global",
    includeWindowImage: true,
    captureConsent: true,
    shortcut: "CommandOrControl+Shift+Space",
    checkpointShortcut: "CommandOrControl+Shift+M",
    retentionMinutes: 10,
    excludedApps: ["1Password"],
    showBubble: true,
    autoStart: true,
    apiKeyConfigured: true,
  };
  const savedEvent = event(
    "saved",
    42,
    "Microsoft Excel",
    "Q3_budget_review.xlsx",
  );
  const checkpoint: ContextCheckpoint = {
    id: "cp-1",
    createdAt: new Date("2026-08-10T09:42:00Z").getTime(),
    event: savedEvent,
    evidence: [],
    explanation,
    reconstruction: {
      summary: "Q3 예산안의 비용 차이를 확인하던 지점이에요.",
      target: "Q3_budget_review.xlsx",
      evidenceIds: ["sheet"],
      nextAction: "비용 증감 열부터 이어서 확인하기",
      source: "model",
    },
  };
  const recall: RecallState = {
    status: "ready",
    trigger: "hotkey",
    current: events[4],
    explanation,
    reconstruction: {
      summary: "A sample 결과를 확인하려고 이 파일로 돌아왔어요.",
      target: "result_0723.xlsx",
      evidenceIds: events.map(({ id }) => id),
      nextAction: "Sample A / Condition B 확인 계속하기",
      source: "model",
    },
    checkpoint,
    mode: "recent",
    updatedAt: at(36),
  };
  const checkpointState: CheckpointState = {
    status: "saved",
    updatedAt: at(36),
    count: 1,
    latest: checkpoint,
  };
  const stats: ActivityStats = {
    running: true,
    paused: false,
    eventCount: events.length,
    retentionMs: 600_000,
    current: events[4],
    lastCapturedAt: events[4].timestamp,
  };
  const bootstrap: DesktopBootstrap = {
    platform: "darwin",
    settings,
    stats,
    recall,
    checkpoint: checkpointState,
    shortcutRegistered: true,
    checkpointShortcutRegistered: true,
    capturePermission: "granted",
  };
  const subscribe = () => () => undefined;

  return {
    bootstrap: async () => bootstrap,
    getSettings: async () => settings,
    saveSettings: async () => settings,
    testConnection: async () => ({
      ok: true,
      models: [settings.model],
      selectedModel: settings.model,
      chatCompletionVerified: true,
      modelsEndpointAvailable: true,
      latencyMs: 184,
    }),
    recall: async () => recall,
    getRecall: async () => recall,
    dismissRecall: async () => undefined,
    openSettings: async () => undefined,
    closeSettings: async () => undefined,
    clearHistory: async () => undefined,
    clearCheckpoints: async () => checkpointState,
    remember: async () => checkpointState,
    pauseCapture: async () => ({ ...stats, paused: true }),
    resumeCapture: async () => stats,
    setBubbleExpanded: async () => undefined,
    onRecall: subscribe,
    onSettings: subscribe,
    onCheckpoint: subscribe,
    onActivity: subscribe,
  };
}
