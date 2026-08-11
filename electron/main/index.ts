import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
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
import { LlmService, type Evidence } from "./llm-service";
import { SettingsStore, settingsPatchSchema } from "./settings-store";
import {
  ACTIVITY_IPC,
  DESKTOP_IPC,
  type ActivityEvent,
  type ActivityStats,
  type ConnectionTestResult,
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
let llm: LlmService;
let shortcutRegistered = false;
let bubbleExpanded = false;
let recallState: RecallState = { status: "idle", updatedAt: Date.now() };
let recallNonce = 0;
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
      width: 760,
      height: 660,
      minWidth: 580,
      minHeight: 470,
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
      width: 540,
      height: 710,
      minWidth: 450,
      minHeight: 560,
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

function registerShortcut(accelerator: string): boolean {
  globalShortcut.unregisterAll();
  shortcutRegistered = globalShortcut.register(
    accelerator,
    () => void recall("hotkey"),
  );
  return shortcutRegistered;
}

function stats(): ActivityStats {
  return (
    monitor?.stats() ?? {
      running: false,
      paused: false,
      eventCount: 0,
      retentionMs: 0,
    }
  );
}

function icon(): Electron.NativeImage {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(app.getAppPath(), "build", "icon.png");
  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty()
    ? nativeImage.createEmpty()
    : image.resize({ width: 24, height: 24 });
}

function refreshTray(): void {
  if (!tray) return;
  const running = stats();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Why was I here?", click: () => void recall("tray") },
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
    summary: explanation?.answer ?? "최근 활동이 아직 충분하지 않습니다.",
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

async function recall(trigger: RecallTrigger = "panel"): Promise<RecallState> {
  const current = monitor?.current();
  const events = monitor?.recent() ?? [];
  const explanation = explainCausalChain({ current, events });
  const nonce = ++recallNonce;
  // The first paint is deterministic and local. Network/model work is optional
  // enrichment, never a reason to make the shortcut wait.
  const fallback = explanationFallback(explanation, current);
  recallState = {
    status: "ready",
    trigger,
    current,
    explanation,
    reconstruction: fallback,
    updatedAt: Date.now(),
  };
  sendAll(DESKTOP_IPC.recallChanged, recallState);
  const window = makeRecall();
  centerOnActiveDisplay(window);
  window.show();
  window.focus();

  const immediate = recallState;
  const evidenceIds = new Set(explanation.evidenceIds);
  const evidence = evidenceFromEvents(
    events.filter((event) => evidenceIds.has(event.id)),
  );
  void llm
    .reconstruct(
      evidence,
      current
        ? {
            id: current.id,
            app: current.appName,
            title: current.title,
          }
        : undefined,
      () => fallback,
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
      shortcutRegistered,
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
      let next = await store.update(patch);
      if (parsed.clearApiKey) next = await store.clearApiKey();
      if (parsed.apiKey?.trim()) next = await store.setApiKey(parsed.apiKey);
      if (next.shortcut !== previous.shortcut) registerShortcut(next.shortcut);
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
      input?: { endpoint: string; model: string; apiKey?: string },
    ): Promise<ConnectionTestResult> => {
      if (!input) return llm.testConnection();
      const parsed = connectionInputSchema.parse(input);
      return llm.testConnection({
        ...parsed,
        apiKey: parsed.apiKey || (await store.getApiKey()),
      });
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
    endpoint: z.string().trim().max(2_048),
    model: z.string().trim().max(300),
    apiKey: z.string().max(8_192).optional(),
  })
  .strict();
const recallTriggerSchema = z.enum([
  "bubble",
  "hotkey",
  "tray",
  "return",
  "panel",
]);

async function bootstrap(): Promise<void> {
  store = new SettingsStore({
    filePath: join(app.getPath("userData"), "settings.json"),
    safeStorage,
    clearHistory: () => monitor?.clear(),
  });
  const settings = await store.initialize();
  llm = new LlmService({
    getConfiguration: async () => ({
      endpoint: (await store.getPublic()).endpoint,
      model: (await store.getPublic()).model,
      apiKey: await store.getApiKey(),
    }),
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
  registerShortcut(settings.shortcut);
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
