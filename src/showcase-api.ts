import type {
  ActivityEvent,
  ActivityStats,
  CheckpointImage,
  CheckpointState,
  ContextCheckpoint,
  DesktopBootstrap,
  HereDesktopApi,
  PublicSettings,
  RecallState,
} from "../electron/shared/contracts";

function createShowcaseWindowImage(): CheckpointImage | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const context = canvas.getContext("2d");
  if (!context) return undefined;

  context.fillStyle = "#f4f4f5";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#202023";
  context.fillRect(0, 0, canvas.width, 48);
  context.fillStyle = "#ffffff";
  context.font = "600 17px Pretendard, sans-serif";
  context.fillText("Q3_예산검토.xlsx", 28, 31);

  context.fillStyle = "#ffffff";
  context.fillRect(24, 72, 912, 440);
  context.fillStyle = "#18181b";
  context.font = "700 25px Pretendard, sans-serif";
  context.fillText("Q3 예산 검토", 56, 116);
  context.fillStyle = "#71717a";
  context.font = "500 14px Pretendard, sans-serif";
  context.fillText("계획과 실제 비용의 차이", 56, 143);

  const left = 56;
  const top = 174;
  const widths = [250, 170, 170, 178];
  const rows = [
    ["구분", "계획", "실제", "증감"],
    ["인건비", "120", "126", "+6"],
    ["외주비", "80", "75", "-5"],
    ["합계", "200", "201", "+1"],
  ];
  rows.forEach((row, rowIndex) => {
    let x = left;
    row.forEach((cell, columnIndex) => {
      const width = widths[columnIndex];
      context.fillStyle =
        rowIndex === 0
          ? "#e4e4e7"
          : rowIndex === 3 && columnIndex === 3
            ? "#fee8e2"
            : rowIndex % 2 === 0
              ? "#fafafa"
              : "#ffffff";
      context.fillRect(x, top + rowIndex * 66, width, 66);
      context.strokeStyle = "#d4d4d8";
      context.strokeRect(x, top + rowIndex * 66, width, 66);
      context.fillStyle = rowIndex === 3 && columnIndex === 3 ? "#c94328" : "#27272a";
      context.font = `${rowIndex === 0 || rowIndex === 3 ? 700 : 550} 16px Pretendard, sans-serif`;
      context.fillText(cell, x + 18, top + rowIndex * 66 + 40);
      x += width;
    });
  });

  return {
    mimeType: "image/png",
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}

/**
 * Development-only, non-sensitive fixture for repeatable product screenshots.
 * Electron always provides the real preload bridge, so this is used only at
 * `?showcase=1` in a Vite development browser.
 */
export function createShowcaseApi(): HereDesktopApi {
  const showcaseQuery = new URLSearchParams(window.location.search);
  const includeWindowImage = showcaseQuery.get("noImage") !== "1";
  const useSavedContext = showcaseQuery.get("saved") === "1";
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
    event("msg", 31, "Microsoft Teams", "재무팀 · Q3 예산안 숫자 확인 부탁드립니다"),
    event("folder", 32, "File Explorer", "재무팀 > 3분기 보고"),
    event("sheet", 33, "Microsoft Excel", "Q3_예산검토.xlsx"),
    event("mail", 34, "Microsoft Outlook", "오후 회의 일정 확인"),
    event("return", 36, "Microsoft Excel", "Q3_예산검토.xlsx"),
  ];
  const explanation = {
    answer: "Q3 예산안 숫자를 확인하려고 열었어요.",
    origin: "Microsoft Teams — 재무팀 · Q3 예산안 숫자 확인 부탁드립니다",
    nextAction: "비용 증감 열의 합계 확인",
    interrupted: true,
    confidence: "high" as const,
    boundary: { reason: "return-chain" as const, at: events[2].timestamp },
    evidenceIds: events.map(({ id }) => id),
    chain: [
      {
        eventId: "msg",
        timestamp: events[0].timestamp,
        label: "Microsoft Teams — 재무팀 · Q3 예산안 숫자 확인 부탁드립니다",
        role: "context" as const,
      },
      {
        eventId: "folder",
        timestamp: events[1].timestamp,
        label: "File Explorer — 재무팀 > 3분기 보고",
        role: "context" as const,
      },
      {
        eventId: "sheet",
        timestamp: events[2].timestamp,
        label: "Microsoft Excel — Q3_예산검토.xlsx",
        role: "context" as const,
      },
      {
        eventId: "mail",
        timestamp: events[3].timestamp,
        label: "Microsoft Outlook — 오후 회의 일정 확인",
        role: "interruption" as const,
      },
      {
        eventId: "return",
        timestamp: events[4].timestamp,
        label: "Microsoft Excel — Q3_예산검토.xlsx",
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
    "Q3_예산검토.xlsx",
  );
  const checkpoint: ContextCheckpoint = {
    id: "cp-1",
    createdAt: new Date("2026-08-10T09:42:00Z").getTime(),
    event: savedEvent,
    evidence: [],
    explanation,
    reconstruction: {
      summary: "Q3 예산안의 비용 차이를 검토하던 중이었어요.",
      target: "비용 증감 열",
      evidenceIds: ["sheet"],
      nextAction: "비용 증감 열 확인",
      source: "model",
    },
  };
  const recall: RecallState = {
    status: "ready",
    trigger: "hotkey",
    current: useSavedContext ? savedEvent : events[4],
    explanation,
    reconstruction: useSavedContext
      ? checkpoint.reconstruction
      : {
          summary: "Q3 예산안 숫자를 확인하려고 열었어요.",
          target: "비용 증감 열",
          evidenceIds: events.map(({ id }) => id),
          nextAction: "비용 증감 열의 합계 확인",
          source: "model",
        },
    checkpoint,
    mode: useSavedContext ? "checkpoint" : "recent",
    contextImage: includeWindowImage ? createShowcaseWindowImage() : undefined,
    updatedAt: useSavedContext ? checkpoint.createdAt : at(36),
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
    health: "healthy",
    captureMode: "polling",
    pollIntervalMs: 500,
    maxEvents: 1_500,
    eventCount: events.length,
    retentionMs: 600_000,
    samplesAttempted: 84,
    samplesObserved: 84,
    readFailures: 0,
    consecutiveReadFailures: 0,
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
      reconstructionVerified: true,
      structuredOutputMode: "json-schema",
      visionRequested: settings.includeWindowImage,
      visionVerified: settings.includeWindowImage,
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
