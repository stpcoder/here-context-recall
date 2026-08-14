import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  safeStorage,
  screen,
  session,
  systemPreferences,
  Tray,
} from "electron";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  ActivityMonitor,
  type NativeWindow,
  type WindowReader,
} from "./activity-monitor";
import { explainCausalChain } from "./causal-engine";
import { calculateCaptureCrop } from "./capture-geometry";
import { CheckpointStore } from "./checkpoint-store";
import {
  LlmService,
  type Evidence,
  type VisionContext,
} from "./llm-service";
import { SettingsStore, settingsPatchSchema } from "./settings-store";
import {
  canUseWorkTraceForModel,
  traceCurrentWork,
} from "./work-trace-engine";
import {
  ACTIVITY_IPC,
  DESKTOP_IPC,
  type ActivityEvent,
  type ActivityStats,
  type CheckpointImage,
  type CheckpointState,
  type ConnectionTestResult,
  type ContextCheckpoint,
  type DesktopBootstrap,
  type ModelReconstruction,
  type PublicSettings,
  type RecallState,
  type RecallTrigger,
  type SaveSettingsInput,
} from "../shared/contracts";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
let bubbleWindow: BrowserWindow | undefined;
let recallWindow: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let monitor: ActivityMonitor | undefined;
let store: SettingsStore;
let checkpointStore: CheckpointStore;
let llm: LlmService;
let shortcutRegistered = false;
let checkpointShortcutRegistered = false;
let bubbleExpanded = false;
let recallState: RecallState = { status: "idle", updatedAt: Date.now() };
let recallNonce = 0;
let checkpointState: CheckpointState = {
  status: "idle",
  updatedAt: Date.now(),
  count: 0,
};
const execFileAsync = promisify(execFile);

function setAutoStart(enabled: boolean): void {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled });
}

function rendererUrl(surface: string): string {
  const query = `surface=${encodeURIComponent(surface)}`;
  if (isDev) return `${process.env.ELECTRON_RENDERER_URL}?${query}`;
  const url = pathToFileURL(join(__dirname, "../renderer/index.html"));
  url.search = query;
  return url.toString();
}

function createWindow(
  options: Electron.BrowserWindowConstructorOptions,
  surface: string,
): BrowserWindow {
  const window = new BrowserWindow({
    ...options,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: isDev,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  void window.loadURL(rendererUrl(surface));
  return window;
}

function makeBubble(): BrowserWindow {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) return bubbleWindow;
  bubbleWindow = createWindow(
    {
      width: 58,
      height: 58,
      transparent: true,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      roundedCorners: true,
      title: "Here",
    },
    "bubble",
  );
  bubbleWindow.setAlwaysOnTop(true, "floating");
  bubbleWindow.on("closed", () => {
    bubbleWindow = undefined;
  });
  return bubbleWindow;
}

function makeRecall(): BrowserWindow {
  if (recallWindow && !recallWindow.isDestroyed()) return recallWindow;
  recallWindow = createWindow(
    {
      width: 860,
      height: 540,
      minWidth: 760,
      minHeight: 540,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      title: "Here — Why was I here?",
    },
    "recall",
  );
  recallWindow.on("close", (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      recallWindow?.hide();
    }
  });
  recallWindow.on("closed", () => {
    recallWindow = undefined;
  });
  return recallWindow;
}

function makeSettings(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow;
  settingsWindow = createWindow(
    {
      width: 600,
      height: 820,
      minWidth: 500,
      minHeight: 640,
      frame: false,
      transparent: true,
      resizable: true,
      title: "Here settings",
    },
    "settings",
  );
  settingsWindow.on("close", (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      settingsWindow?.hide();
    }
  });
  settingsWindow.on("closed", () => {
    settingsWindow = undefined;
  });
  return settingsWindow;
}

function centerOnActiveDisplay(window: BrowserWindow): void {
  const bounds = monitor?.current()?.bounds;
  const display = bounds
    ? screen.getDisplayMatching(bounds)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const [width, height] = window.getSize();
  window.setPosition(
    Math.round(area.x + (area.width - width) / 2),
    Math.round(area.y + (area.height - height) / 2),
  );
}

function positionBubble(event?: ActivityEvent): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  const size = bubbleExpanded
    ? { width: 242, height: 58 }
    : { width: 58, height: 58 };
  const display = event?.bounds
    ? screen.getDisplayMatching(event.bounds)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const suggestedX = event?.bounds
    ? event.bounds.x + event.bounds.width - size.width - 14
    : area.x + area.width - size.width - 20;
  const suggestedY = event?.bounds
    ? event.bounds.y + event.bounds.height - size.height - 22
    : area.y + Math.round((area.height - size.height) / 2);
  const x = Math.max(
    area.x + 8,
    Math.min(suggestedX, area.x + area.width - size.width - 8),
  );
  const y = Math.max(
    area.y + 8,
    Math.min(suggestedY, area.y + area.height - size.height - 8),
  );
  bubbleWindow.setBounds(
    { x: Math.round(x), y: Math.round(y), ...size },
    false,
  );
}

function sendAll(channel: string, payload: unknown): void {
  for (const window of [bubbleWindow, recallWindow, settingsWindow]) {
    if (window && !window.isDestroyed())
      window.webContents.send(channel, payload);
  }
}

async function applyCapture(settings: PublicSettings): Promise<void> {
  monitor?.stop();
  monitor = undefined;
  if (!settings.captureConsent) {
    bubbleWindow?.hide();
    refreshTray();
    return;
  }
  monitor = new ActivityMonitor(
    {
      retentionMs: settings.retentionMinutes * 60_000,
      excludedApps: settings.excludedApps,
      hereProcessId: process.pid,
      requestPermissions:
        process.platform === "darwin" &&
        process.env.HERE_SKIP_OS_PERMISSION_PROMPTS !== "1",
    },
    packagedMacWindowReader(),
  );
  monitor.onEvent((event) => {
    sendAll(ACTIVITY_IPC.event, event);
    if (event.kind === "window-focus") positionBubble(event);
  });
  await monitor.start();
  if (settings.showBubble) {
    makeBubble();
    positionBubble(monitor.current());
    bubbleWindow?.showInactive();
  } else {
    bubbleWindow?.hide();
  }
  refreshTray();
}

function packagedMacWindowReader(): WindowReader | undefined {
  if (process.platform !== "darwin" || !app.isPackaged) return undefined;
  const binary = join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "get-windows",
    "main",
  );
  const read = async (
    openWindows: boolean,
    options?: Record<string, unknown>,
  ): Promise<NativeWindow | NativeWindow[] | undefined> => {
    const args: string[] = [];
    if (options?.accessibilityPermission === false)
      args.push("--no-accessibility-permission");
    if (options?.screenRecordingPermission === false)
      args.push("--no-screen-recording-permission");
    if (openWindows) args.push("--open-windows-list");
    const { stdout } = await execFileAsync(binary, args, {
      encoding: "utf8",
      timeout: 2_500,
      maxBuffer: 2_000_000,
    });
    return JSON.parse(String(stdout)) as
      | NativeWindow
      | NativeWindow[]
      | undefined;
  };
  return {
    activeWindow: (options?: Record<string, unknown>) =>
      read(false, options) as Promise<NativeWindow | undefined>,
    openWindows: (options?: Record<string, unknown>) =>
      read(true, options) as Promise<NativeWindow[]>,
  };
}

function registerShortcuts(settings: PublicSettings): void {
  globalShortcut.unregisterAll();
  shortcutRegistered = globalShortcut.register(
    settings.shortcut,
    () => void recall("hotkey"),
  );
  checkpointShortcutRegistered = globalShortcut.register(
    settings.checkpointShortcut,
    () => void remember(),
  );
}

function stats(): ActivityStats {
  return (
    monitor?.stats() ?? {
      running: false,
      paused: false,
      health: "stopped",
      captureMode: "polling",
      pollIntervalMs: 500,
      maxEvents: 1_500,
      eventCount: 0,
      retentionMs: 0,
      samplesAttempted: 0,
      samplesObserved: 0,
      readFailures: 0,
      consecutiveReadFailures: 0,
    }
  );
}

function icon(): Electron.NativeImage {
  return appIcon(24);
}

function appIcon(width: number): Electron.NativeImage {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(app.getAppPath(), "build", "icon.png");
  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty()
    ? nativeImage.createEmpty()
    : image.resize({ width, height: width, quality: "good" });
}

function refreshTray(): void {
  if (!tray) return;
  const running = stats();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Why was I here?", click: () => void recall("tray") },
      { label: "Remember here", click: () => void remember() },
      { type: "separator" },
      {
        label: running.paused ? "Resume capture" : "Pause capture",
        click: () => void (running.paused ? resumeCapture() : pauseCapture()),
      },
      { label: "Settings…", click: () => void openSettings() },
      { type: "separator" },
      {
        label: "Quit Here",
        click: () => {
          app.isQuiting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function macPermission(): Promise<DesktopBootstrap["capturePermission"]> {
  if (process.platform !== "darwin") return "not-needed";
  try {
    const screenPermission = systemPreferences.getMediaAccessStatus("screen");
    if (
      screenPermission === "granted" &&
      systemPreferences.isTrustedAccessibilityClient(false)
    )
      return "granted";
    return screenPermission;
  } catch {
    return "unknown";
  }
}

function explanationFallback(
  explanation = recallState.explanation,
  current = recallState.current,
): ModelReconstruction {
  const target = current?.title ?? current?.appName ?? "현재 창";
  return {
    summary: explanation?.answer ?? "최근에 사용한 창이 아직 충분하지 않습니다.",
    target,
    evidenceIds: explanation?.evidenceIds ?? [],
    nextAction: explanation?.nextAction,
    source: "fallback",
  };
}

function evidenceFromEvents(events: ActivityEvent[]): Evidence[] {
  return events
    .filter((event) => event.kind === "window-focus")
    .map((event) => ({
      id: event.id,
      at: new Date(event.timestamp).toISOString(),
      app: event.appName ?? "Unknown app",
      title:
        event.title ?? (event.titleRedacted ? "[Title hidden]" : "Untitled"),
      kind: "focus" as const,
    }));
}

function checkpointForState(
  checkpoint?: ContextCheckpoint,
): ContextCheckpoint | undefined {
  if (!checkpoint) return undefined;
  return {
    ...checkpoint,
    evidence: [],
    image: undefined,
  };
}

function currentCheckpointState(
  status: CheckpointState["status"] = checkpointState.status,
  message = checkpointState.message,
): CheckpointState {
  return {
    status,
    updatedAt: Date.now(),
    count: checkpointStore?.count() ?? 0,
    latest: checkpointForState(checkpointStore?.latest()),
    message,
  };
}

function visionFromImage(image?: CheckpointImage): VisionContext | undefined {
  if (!image) return undefined;
  const comma = image.dataUrl.indexOf(",");
  if (comma < 0) return undefined;
  return {
    mimeType: image.mimeType,
    dataBase64: image.dataUrl.slice(comma + 1),
  };
}

function connectionProbeVision(): VisionContext | undefined {
  const data = appIcon(96).toPNG();
  if (!data.length) return undefined;
  return { mimeType: "image/png", dataBase64: data.toString("base64") };
}

async function captureWindowImage(
  event: ActivityEvent | undefined,
  settings: PublicSettings,
): Promise<CheckpointImage | undefined> {
  if (
    !settings.captureConsent ||
    !settings.includeWindowImage ||
    !event?.bounds
  )
    return undefined;
  const display = screen.getDisplayMatching(event.bounds);
  const displayBounds = display.bounds;
  const requestedWidth = Math.max(640, Math.min(1_920, displayBounds.width));
  const scale = requestedWidth / displayBounds.width;
  const requestedHeight = Math.max(360, Math.round(displayBounds.height * scale));
  const restoreBubble = Boolean(
    bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible(),
  );
  const restoreRecall = Boolean(
    recallWindow && !recallWindow.isDestroyed() && recallWindow.isVisible(),
  );
  const restoreSettings = Boolean(
    settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible(),
  );
  const recallWasFocused = Boolean(restoreRecall && recallWindow?.isFocused());
  const settingsWasFocused = Boolean(
    restoreSettings && settingsWindow?.isFocused(),
  );
  if (restoreBubble) bubbleWindow?.hide();
  if (restoreRecall) recallWindow?.hide();
  if (restoreSettings) settingsWindow?.hide();
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const fresh = await monitor?.snapshot();
    if (!fresh || fresh.id !== event.id) return undefined;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      fetchWindowIcons: false,
      thumbnailSize: { width: requestedWidth, height: requestedHeight },
    });
    const source =
      sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) return undefined;
    const fullSize = source.thumbnail.getSize();
    const crop = calculateCaptureCrop(displayBounds, fullSize, event.bounds);
    if (!crop) return undefined;
    let image = source.thumbnail.crop(crop);
    if (image.isEmpty()) return undefined;
    const croppedSize = image.getSize();
    if (croppedSize.width > 1_280)
      image = image.resize({ width: 1_280, quality: "good" });
    const size = image.getSize();
    const data = image.toJPEG(72);
    if (!data.length || data.length > 1_500_000) return undefined;
    return {
      mimeType: "image/jpeg",
      dataUrl: `data:image/jpeg;base64,${data.toString("base64")}`,
      width: size.width,
      height: size.height,
      capturedAt: Date.now(),
      sourceEventId: event.id,
    };
  } catch {
    return undefined;
  } finally {
    if (restoreBubble && settings.showBubble) bubbleWindow?.showInactive();
    if (restoreRecall) {
      recallWindow?.show();
      if (recallWasFocused) recallWindow?.focus();
    }
    if (restoreSettings) {
      settingsWindow?.show();
      if (settingsWasFocused) settingsWindow?.focus();
    }
  }
}

async function remember(): Promise<CheckpointState> {
  checkpointState = currentCheckpointState("saving");
  sendAll(DESKTOP_IPC.checkpointChanged, checkpointState);
  try {
    const settings = await store.getPublic();
    if (!settings.captureConsent)
      throw new Error("먼저 ‘최근 사용한 창 기록’을 켜 주세요.");
    const current = await monitor?.snapshot();
    if (!current) throw new Error("저장할 수 있는 현재 창이 없습니다.");
    const recent = monitor?.recent() ?? [];
    const explanation = explainCausalChain({ current, events: recent });
    const selectedIds = new Set([...explanation.evidenceIds, current.id]);
    const evidence = recent
      .filter((event) => selectedIds.has(event.id))
      .slice(-12);
    if (!evidence.some((event) => event.id === current.id)) evidence.push(current);
    const image = await captureWindowImage(current, settings);
    const fallback = explanationFallback(explanation, current);
    const checkpoint = await checkpointStore.save({
      event: current,
      evidence,
      explanation,
      reconstruction: fallback,
      image,
    });
    checkpointState = currentCheckpointState("saved", "이 작업을 저장했어요.");
    sendAll(DESKTOP_IPC.checkpointChanged, checkpointState);
    if (settings.showBubble) {
      makeBubble();
      positionBubble(current);
      bubbleWindow?.showInactive();
    } else if (Notification.isSupported()) {
      new Notification({
        title: "Here",
        body: "이 작업을 저장했어요.",
        silent: true,
      }).show();
    }
    const modelEvidence = evidenceFromEvents(evidence);
    if (explanation.confidence !== "low" && modelEvidence.length >= 2)
      void llm.reconstruct(
          modelEvidence,
          { id: current.id, app: current.appName, title: current.title },
          () => fallback,
          visionFromImage(image),
        )
      .then(async (reconstruction) => {
        const updated = await checkpointStore.setReconstruction(
          checkpoint.id,
          reconstruction,
        );
        if (!updated) return;
        checkpointState = currentCheckpointState(
          "saved",
          "AI가 다음 할 일까지 정리했어요.",
        );
        sendAll(DESKTOP_IPC.checkpointChanged, checkpointState);
      })
      .catch(() => {
        // The encrypted local checkpoint is already complete. Model enrichment
        // is deliberately best-effort and must never undo the remembered state.
      });
  } catch (error) {
    checkpointState = currentCheckpointState(
      "error",
      error instanceof Error ? error.message : "작업을 저장하지 못했어요.",
    );
    sendAll(DESKTOP_IPC.checkpointChanged, checkpointState);
  }
  return checkpointState;
}

async function recall(trigger: RecallTrigger = "panel"): Promise<RecallState> {
  const settings = await store.getPublic();
  const recentCurrent = await monitor?.snapshot();
  const recentEvents = monitor?.recent() ?? [];
  const checkpoint = checkpointStore.latest();
  const focusCount = recentEvents.filter(
    (event) => event.kind === "window-focus",
  ).length;
  const useCheckpoint = Boolean(
    checkpoint && (trigger === "saved" || focusCount < 2),
  );
  const current = useCheckpoint ? checkpoint?.event : recentCurrent;
  const events = useCheckpoint ? checkpoint?.evidence ?? [] : recentEvents;
  const explanation =
    (useCheckpoint ? checkpoint?.explanation : undefined) ??
    explainCausalChain({ current, events });
  const workTrace = useCheckpoint
    ? undefined
    : traceCurrentWork({ current, events }).slice;
  const image = useCheckpoint
    ? checkpoint?.image
    : await captureWindowImage(current, settings);
  const nonce = ++recallNonce;
  // The first paint is deterministic and local. Network/model work is optional
  // enrichment, never a reason to make the shortcut wait.
  const fallback =
    (useCheckpoint ? checkpoint?.reconstruction : undefined) ??
    explanationFallback(explanation, current);
  recallState = {
    status: "ready",
    trigger,
    current,
    explanation,
    reconstruction: fallback,
    workTrace: workTrace
      ? {
          traceId: workTrace.traceId,
          currentEvidenceId: workTrace.currentEvidenceId,
          rootEvidenceId: workTrace.rootEvidenceId,
          workEvidenceIds: workTrace.workEvidenceIds,
          detourEvidenceIds: workTrace.detourEvidenceIds,
          excludedEventCount: workTrace.excludedEventCount,
          confidence: workTrace.confidence,
          proof: workTrace.proof.map(({ kind, strength, detail }) => ({
            kind,
            strength,
            detail,
          })),
        }
      : undefined,
    checkpoint,
    mode: useCheckpoint ? "checkpoint" : "recent",
    contextImage: image,
    updatedAt: Date.now(),
  };
  sendAll(DESKTOP_IPC.recallChanged, recallState);
  const window = makeRecall();
  centerOnActiveDisplay(window);
  window.show();
  window.focus();

  const immediate = recallState;
  const filteredByTrace = canUseWorkTraceForModel(workTrace);
  const evidenceIds = new Set(
    filteredByTrace
      ? [
          ...workTrace!.workEvidenceIds,
          ...workTrace!.detourEvidenceIds,
          ...(current ? [current.id] : []),
        ]
      : [
          ...explanation.evidenceIds,
          ...(current ? [current.id] : []),
        ],
  );
  const evidence = evidenceFromEvents(
    events.filter((event) => evidenceIds.has(event.id)),
  );
  const checkpointAlreadyEnriched = Boolean(
    useCheckpoint && checkpoint?.reconstruction?.source === "model",
  );
  if (
    !checkpointAlreadyEnriched &&
    explanation.confidence !== "low" &&
    evidence.length >= 2
  )
    void llm.reconstruct(
        evidence,
        current
          ? {
              id: current.id,
              app: current.appName,
              title: current.title,
            }
          : undefined,
        () => fallback,
        visionFromImage(image),
      )
    .then((reconstruction) => {
      if (nonce !== recallNonce) return;
      recallState = {
        ...recallState,
        status: "ready",
        reconstruction,
        updatedAt: Date.now(),
      };
      sendAll(DESKTOP_IPC.recallChanged, recallState);
      if (useCheckpoint && checkpoint)
        void checkpointStore
          .setReconstruction(checkpoint.id, reconstruction)
          .catch(() => undefined);
    })
    .catch(() => {
      // Recall was already rendered from observed local evidence.
    });
  return immediate;
}

async function openSettings(): Promise<void> {
  const window = makeSettings();
  centerOnActiveDisplay(window);
  window.show();
  window.focus();
}

async function pauseCapture(): Promise<ActivityStats> {
  const result = await monitor?.pause();
  refreshTray();
  return result ?? stats();
}
async function resumeCapture(): Promise<ActivityStats> {
  const result = await monitor?.resume();
  refreshTray();
  return result ?? stats();
}

function registerIpc(): void {
  ipcMain.handle(
    DESKTOP_IPC.bootstrap,
    async (): Promise<DesktopBootstrap> => ({
      platform: process.platform,
      settings: await store.getPublic(),
      stats: stats(),
      recall: recallState,
      checkpoint: currentCheckpointState(),
      shortcutRegistered,
      checkpointShortcutRegistered,
      capturePermission: await macPermission(),
    }),
  );
  ipcMain.handle(DESKTOP_IPC.getSettings, () => store.getPublic());
  ipcMain.handle(
    DESKTOP_IPC.saveSettings,
    async (_event, input: SaveSettingsInput): Promise<PublicSettings> => {
      const parsed = saveInputSchema.parse(input);
      const patch = settingsPatchSchema.parse(parsed.settings);
      const previous = await store.getPublic();
      const next = await store.saveWithApiKey(patch, {
        apiKey: parsed.apiKey,
        clearApiKey: parsed.clearApiKey,
      });
      if (
        next.shortcut !== previous.shortcut ||
        next.checkpointShortcut !== previous.checkpointShortcut
      )
        registerShortcuts(next);
      if (next.autoStart !== previous.autoStart) setAutoStart(next.autoStart);
      const capturePolicyChanged =
        next.captureConsent !== previous.captureConsent ||
        next.retentionMinutes !== previous.retentionMinutes ||
        JSON.stringify(next.excludedApps) !==
          JSON.stringify(previous.excludedApps);
      if (capturePolicyChanged) {
        await applyCapture(next);
      } else if (next.showBubble !== previous.showBubble) {
        if (next.captureConsent && next.showBubble) {
          makeBubble();
          positionBubble(monitor?.current());
          bubbleWindow?.showInactive();
        } else bubbleWindow?.hide();
      }
      sendAll(DESKTOP_IPC.settingsChanged, next);
      return next;
    },
  );
  ipcMain.handle(
    DESKTOP_IPC.testConnection,
    async (
      _event,
      input?: {
        modelProvider: PublicSettings["modelProvider"];
        endpoint: string;
        model: string;
        vertexProject: string;
        vertexLocation: string;
        apiKey?: string;
        testVision?: boolean;
      },
    ): Promise<ConnectionTestResult> => {
      if (!input) return llm.testConnection();
      const parsed = connectionInputSchema.parse(input);
      return llm.testConnection(
        {
          ...parsed,
          apiKey: parsed.apiKey || (await store.getApiKey()),
        },
        {
          visionRequested: parsed.testVision,
          vision: parsed.testVision ? connectionProbeVision() : undefined,
        },
      );
    },
  );
  ipcMain.handle(DESKTOP_IPC.recall, (_event, trigger?: RecallTrigger) =>
    recall(recallTriggerSchema.parse(trigger ?? "panel")),
  );
  ipcMain.handle(DESKTOP_IPC.getRecall, () => recallState);
  ipcMain.handle(DESKTOP_IPC.dismissRecall, () => {
    recallWindow?.hide();
  });
  ipcMain.handle(DESKTOP_IPC.openSettings, openSettings);
  ipcMain.handle(DESKTOP_IPC.closeSettings, () => {
    settingsWindow?.hide();
  });
  ipcMain.handle(DESKTOP_IPC.clearHistory, () => {
    monitor?.clear();
  });
  ipcMain.handle(DESKTOP_IPC.clearCheckpoints, async () => {
    await checkpointStore.clear();
    checkpointState = currentCheckpointState("idle", "저장한 작업을 모두 지웠어요.");
    sendAll(DESKTOP_IPC.checkpointChanged, checkpointState);
    return checkpointState;
  });
  ipcMain.handle(DESKTOP_IPC.remember, remember);
  ipcMain.handle(DESKTOP_IPC.pauseCapture, pauseCapture);
  ipcMain.handle(DESKTOP_IPC.resumeCapture, resumeCapture);
  ipcMain.handle(DESKTOP_IPC.setBubbleExpanded, (_event, expanded: unknown) => {
    bubbleExpanded = z.boolean().parse(expanded);
    positionBubble(monitor?.current());
  });
}

const saveInputSchema = z
  .object({
    settings: settingsPatchSchema,
    apiKey: z.string().max(8_192).optional(),
    clearApiKey: z.boolean().optional(),
  })
  .strict();
const connectionInputSchema = z
  .object({
    modelProvider: z.enum(["openai-compatible", "vertex-gcloud"]),
    endpoint: z.string().trim().max(2_048),
    model: z.string().trim().max(300),
    vertexProject: z.string().trim().max(300),
    vertexLocation: z.string().trim().max(100),
    apiKey: z.string().max(8_192).optional(),
    testVision: z.boolean().optional(),
  })
  .strict();
const recallTriggerSchema = z.enum([
  "bubble",
  "hotkey",
  "tray",
  "return",
  "panel",
  "saved",
]);

async function bootstrap(): Promise<void> {
  store = new SettingsStore({
    filePath: join(app.getPath("userData"), "settings.json"),
    safeStorage,
    clearHistory: () => monitor?.clear(),
  });
  const settings = await store.initialize();
  checkpointStore = new CheckpointStore({
    filePath: join(app.getPath("userData"), "checkpoints.bin"),
    safeStorage,
  });
  await checkpointStore.initialize();
  checkpointState = currentCheckpointState("idle");
  llm = new LlmService({
    getConfiguration: async () => {
      const current = await store.getPublic();
      return {
        modelProvider: current.modelProvider,
        endpoint: current.endpoint,
        model: current.model,
        vertexProject: current.vertexProject,
        vertexLocation: current.vertexLocation,
        apiKey: await store.getApiKey(),
      };
    },
    // Electron's network stack follows the desktop's proxy and certificate
    // configuration, which is essential for internal vLLM gateways.
    fetch: net.fetch as typeof fetch,
  });
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (_event, item) => item.cancel());
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) =>
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'",
          ],
        },
      }),
    );
  }
  registerIpc();
  tray = new Tray(icon());
  tray.setToolTip("Here — Why was I here?");
  tray.on("click", () => void recall("tray"));
  registerShortcuts(settings);
  if (settings.autoStart) setAutoStart(true);
  await applyCapture(settings);
  if (!settings.captureConsent) await openSettings();
}

if (process.platform === "win32")
  app.setAppUserModelId("com.here.contextrecall");

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => void recall("tray"));
  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      console.error("Here startup failed", error);
      app.quit();
    });
  app.on("activate", () => {
    if (!store) return;
    void store.getPublic().then((settings) => {
      if (settings.captureConsent) void recall("tray");
      else void openSettings();
    });
  });
  app.on("before-quit", () => {
    app.isQuiting = true;
    monitor?.stop();
    globalShortcut.unregisterAll();
  });
}

declare global {
  namespace Electron {
    interface App {
      isQuiting?: boolean;
    }
  }
}
