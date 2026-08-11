import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../shared/contracts";
import { explainCausalChain } from "./causal-engine";

const event = (
  id: string,
  timestamp: number,
  appName: string,
  title: string,
): ActivityEvent => ({
  id,
  timestamp,
  kind: "window-focus",
  appName,
  title,
  platform: "win32",
});

const marker = (
  id: string,
  timestamp: number,
  kind: "monitor-paused" | "monitor-resumed" | "capture-gap",
): ActivityEvent => ({
  id,
  timestamp,
  kind,
  platform: "win32",
  gapReason: kind === "capture-gap" ? "protected" : undefined,
});

describe("explainCausalChain", () => {
  it("identifies an observed A → interruption → A return without inventing intent", () => {
    const events = [
      event("search", 1, "File Explorer", "Evaluation results"),
      event("sheet", 2, "Microsoft Excel", "result_0723.xlsx"),
      event("slack", 3, "Slack", "A sample results?"),
      event("return", 4, "Microsoft Excel", "result_0723.xlsx"),
    ];
    const result = explainCausalChain({ events, current: events[3] });

    expect(result.interrupted).toBe(true);
    expect(result.origin).toBe("Microsoft Excel — result_0723.xlsx");
    expect(result.chain.map((step) => step.role)).toEqual([
      "context",
      "context",
      "interruption",
      "return",
    ]);
    expect(result.evidenceIds).toEqual(["search", "sheet", "slack", "return"]);
    expect(result.answer).not.toContain("Sample A");
    expect(result.confidence).toBe("high");
    expect(result.boundary.reason).toBe("return-chain");
  });

  it("does not mistake two browser pages in one HWND for the same target", () => {
    const first = { ...event("a", 1, "Chrome", "Budget search"), windowId: "77" };
    const second = { ...event("b", 2, "Chrome", "Budget report"), windowId: "77" };
    const result = explainCausalChain({ events: [first, second] });
    expect(result.interrupted).toBe(false);
    expect(result.origin).toBe("Chrome — Budget search");
    expect(result.boundary.reason).toBe("recent-window");
  });

  it("uses a privacy-safe gap as interruption evidence without exposing its app", () => {
    const first = event("a", 1, "Excel", "Q3.xlsx");
    const gap = marker("gap", 2, "capture-gap");
    const returned = event("b", 3, "Excel", "Q3.xlsx");
    const result = explainCausalChain({ events: [first, gap, returned] });
    expect(result.interrupted).toBe(true);
    expect(result.chain.map((step) => step.label)).toEqual([
      "Excel — Q3.xlsx",
      "보호된 창 — 내용 기록 안 함",
      "Excel — Q3.xlsx",
    ]);
    expect(result.confidence).toBe("medium");
  });

  it("cuts at an explicit resume and at long inactivity when there is no return", () => {
    const before = event("before", 1, "Teams", "Old task");
    const resumed = marker("resume", 2, "monitor-resumed");
    const current = event("current", 3, "Excel", "New task.xlsx");
    const explicit = explainCausalChain({ events: [before, resumed, current] });
    expect(explicit.evidenceIds).toEqual(["current"]);
    expect(explicit.boundary.reason).toBe("explicit-resume");

    const afterGap = event("after-gap", 4 * 60 * 1_000 + 10, "Chrome", "New task");
    const inactive = explainCausalChain({ events: [before, afterGap] });
    expect(inactive.evidenceIds).toEqual(["after-gap"]);
    expect(inactive.boundary.reason).toBe("inactivity");
  });

  it("preserves an exact return across a long gap inside the retention window", () => {
    const first = event("first", 1, "Excel", "Q3.xlsx");
    const interruption = event("mail", 2, "Outlook", "Inbox");
    const returned = event(
      "returned",
      4 * 60 * 1_000 + 20,
      "Excel",
      "Q3.xlsx",
    );
    const result = explainCausalChain({ events: [first, interruption, returned] });
    expect(result.interrupted).toBe(true);
    expect(result.evidenceIds).toEqual(["first", "mail", "returned"]);
  });

  it("uses only the latest five focus observations and handles no activity", () => {
    const events = Array.from({ length: 6 }, (_, index) =>
      event(`${index}`, index, "App", `Window ${index}`),
    );
    expect(explainCausalChain({ events }).chain).toHaveLength(5);
    expect(explainCausalChain({ events: [] })).toMatchObject({
      interrupted: false,
      evidenceIds: [],
    });
  });

  it("keeps the original target in a long A → many windows → A return chain", () => {
    const events = [
      event("before", 1, "Explorer", "Evaluation results"),
      event("origin", 2, "Microsoft Excel", "result.xlsx"),
      event("one", 3, "Teams", "Project room"),
      event("two", 4, "Outlook", "Inbox"),
      event("three", 5, "Chrome", "Search"),
      event("four", 6, "Notepad", "Notes"),
      event("return", 7, "Microsoft Excel", "result.xlsx"),
    ];
    const result = explainCausalChain({ events });
    expect(result.interrupted).toBe(true);
    expect(result.evidenceIds).toContain("origin");
    expect(result.evidenceIds).toContain("return");
    expect(result.evidenceIds).toHaveLength(5);
  });
});
