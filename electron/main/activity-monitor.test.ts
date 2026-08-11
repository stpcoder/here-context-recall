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
    expect(monitor.recent()).toHaveLength(0);
    active = sample(2, "Google Chrome", "Incognito");
    await vi.advanceTimersByTimeAsync(25);
    expect(monitor.recent()).toHaveLength(0);
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
