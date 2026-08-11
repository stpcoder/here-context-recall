import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityMonitor } from "./activity-monitor";

type WindowSample = {
  id: number;
  title: string;
  owner: { name: string; processId: number; path: string };
  bounds: { x: number; y: number; width: number; height: number };
};

const sample = (
  id: number,
  app: string,
  title: string,
  x = 10,
): WindowSample => ({
  id,
  title,
  owner: { name: app, processId: id + 100, path: `C:\\Apps\\${app}.exe` },
  bounds: { x, y: 20, width: 900, height: 650 },
});

afterEach(() => vi.useRealTimers());

describe("ActivityMonitor", () => {
  it("records real focus changes, refreshes bounds without polluting the chain, and clears memory", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-11T05:00:00Z") });
    let active = sample(1, "Explorer", "Evaluation results");
    const reader = { activeWindow: vi.fn(async () => active) };
    const monitor = new ActivityMonitor(
      { platform: "win32", pollIntervalMs: 25, hereProcessId: 999 },
      reader,
    );

    await monitor.start();
    expect(monitor.recent().map(({ title }) => title)).toEqual([
      "Evaluation results",
    ]);

    active = sample(2, "Microsoft Excel", "result_0723.xlsx");
    await vi.advanceTimersByTimeAsync(25);
    expect(monitor.recent().map(({ title }) => title)).toEqual([
      "Evaluation results",
      "result_0723.xlsx",
    ]);

    active = sample(2, "Microsoft Excel", "result_0723.xlsx", 120);
    await vi.advanceTimersByTimeAsync(25);
    expect(monitor.recent()).toHaveLength(2);
    expect(monitor.current()?.bounds?.x).toBe(120);

    monitor.clear();
    expect(monitor.stats().eventCount).toBe(0);
    monitor.stop();
  });

  it("never records password managers or private browser windows", async () => {
    vi.useFakeTimers();
    let active = sample(1, "1Password", "Private vault");
    const reader = { activeWindow: vi.fn(async () => active) };
    const monitor = new ActivityMonitor(
      { platform: "win32", pollIntervalMs: 25, hereProcessId: 999 },
      reader,
    );

    await monitor.start();
    expect(monitor.recent()).toMatchObject([
      { kind: "capture-gap", gapReason: "protected" },
    ]);
    expect(monitor.recent()[0]).not.toHaveProperty("appName");
    expect(monitor.recent()[0]).not.toHaveProperty("title");
    active = sample(2, "Google Chrome", "Incognito");
    await vi.advanceTimersByTimeAsync(25);
    expect(monitor.recent()).toHaveLength(1);
    expect(monitor.recent()[0].sampleCount).toBe(2);
    monitor.stop();
  });

  it("records a stable page title change even when the Windows HWND is reused", async () => {
    vi.useFakeTimers();
    let active = sample(7, "Google Chrome", "Budget search");
    const reader = { activeWindow: vi.fn(async () => active) };
    const monitor = new ActivityMonitor(
      { platform: "win32", pollIntervalMs: 25, hereProcessId: 999 },
      reader,
    );
    await monitor.start();
    active = sample(7, "Google Chrome", "Q3 budget — SharePoint");
    await vi.advanceTimersByTimeAsync(25);
    expect(monitor.recent().map((event) => event.title)).toEqual([
      "Budget search",
      "Q3 budget — SharePoint",
    ]);
    monitor.stop();
  });

  it("records a privacy-safe gap and a real return to the same window", async () => {
    vi.useFakeTimers();
    let active = sample(3, "Microsoft Excel", "Q3.xlsx");
    const reader = { activeWindow: vi.fn(async () => active) };
    const monitor = new ActivityMonitor(
      { platform: "win32", pollIntervalMs: 25, hereProcessId: 999 },
      reader,
    );
    await monitor.start();
    active = sample(4, "1Password", "Vault");
    await vi.advanceTimersByTimeAsync(25);
    active = sample(3, "Microsoft Excel", "Q3.xlsx");
    await vi.advanceTimersByTimeAsync(25);
    expect(monitor.recent().map((event) => event.kind)).toEqual([
      "window-focus",
      "capture-gap",
      "window-focus",
    ]);
    expect(monitor.current()?.title).toBe("Q3.xlsx");
    monitor.stop();
  });

  it("keeps a continuously observed current window while pruning old context", async () => {
    vi.useFakeTimers();
    const reader = {
      activeWindow: vi.fn(async () => sample(1, "Notepad", "Long task")),
    };
    const monitor = new ActivityMonitor(
      {
        platform: "win32",
        pollIntervalMs: 25,
        retentionMs: 100,
        hereProcessId: 999,
      },
      reader,
    );
    await monitor.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(monitor.current()?.title).toBe("Long task");
    expect(monitor.current()?.sampleCount).toBeGreaterThan(5);
    expect(monitor.stats().lastCapturedAt).toBe(Date.now());
    monitor.stop();
  });

  it("surfaces repeated reader failure as a generic gap and degraded health", async () => {
    vi.useFakeTimers();
    const reader = { activeWindow: vi.fn(async () => undefined) };
    const monitor = new ActivityMonitor(
      { platform: "win32", pollIntervalMs: 25, hereProcessId: 999 },
      reader,
    );
    await monitor.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(monitor.stats()).toMatchObject({
      health: "degraded",
      samplesAttempted: 3,
      samplesObserved: 0,
      readFailures: 3,
      consecutiveReadFailures: 3,
      current: undefined,
    });
    expect(monitor.recent()).toMatchObject([
      { kind: "capture-gap", gapReason: "unavailable" },
    ]);
    monitor.stop();
  });

  it("recovers after a reader gap and keeps the ring buffer strictly bounded", async () => {
    vi.useFakeTimers();
    let active: WindowSample | undefined;
    const reader = { activeWindow: vi.fn(async () => active) };
    const monitor = new ActivityMonitor(
      {
        platform: "win32",
        pollIntervalMs: 25,
        maxEvents: 20,
        hereProcessId: 999,
      },
      reader,
    );
    await monitor.start();
    await vi.advanceTimersByTimeAsync(50);
    active = sample(10, "Notepad", "Recovered");
    await vi.advanceTimersByTimeAsync(25);
    expect(monitor.stats()).toMatchObject({
      health: "healthy",
      consecutiveReadFailures: 0,
      current: { title: "Recovered" },
    });

    for (let index = 0; index < 25; index += 1) {
      active = sample(10, "Notepad", `Page ${index}`);
      await vi.advanceTimersByTimeAsync(25);
    }
    expect(monitor.recent()).toHaveLength(20);
    expect(monitor.recent().at(-1)?.title).toBe("Page 24");
    monitor.stop();
  });

  it("passes explicit false permission options on macOS instead of triggering package defaults", async () => {
    const reader = { activeWindow: vi.fn(async () => sample(1, "Finder", "")) };
    const monitor = new ActivityMonitor(
      { platform: "darwin", pollIntervalMs: 1_000, requestPermissions: false },
      reader,
    );
    await monitor.start();
    expect(reader.activeWindow).toHaveBeenCalledWith({
      accessibilityPermission: false,
      screenRecordingPermission: false,
    });
    monitor.stop();
  });

  it("looks behind its own always-on-top bubble without bypassing ordinary exclusions", async () => {
    const ownWindow = sample(1, "Electron", "Here");
    ownWindow.owner.processId = 999;
    const finder = sample(2, "Finder", "Documents");
    const reader = {
      activeWindow: vi.fn(async () => ownWindow),
      openWindows: vi.fn(async () => [ownWindow, finder]),
    };
    const monitor = new ActivityMonitor(
      { platform: "darwin", hereProcessId: 999, requestPermissions: false },
      reader,
    );
    await monitor.start();
    expect(monitor.current()?.appName).toBe("Finder");
    expect(reader.openWindows).toHaveBeenCalledWith({
      accessibilityPermission: false,
      screenRecordingPermission: false,
    });
    monitor.stop();
  });
});
