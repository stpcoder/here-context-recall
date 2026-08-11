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
