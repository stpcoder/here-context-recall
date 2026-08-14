import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../shared/contracts";
import {
  buildWorkTraceGraph,
  canUseWorkTraceForModel,
  sliceCurrentWork,
  traceCurrentWork,
  type WorkTraceAnchor,
} from "./work-trace-engine";

const event = (
  id: string,
  second: number,
  appName: string,
  title: string,
): ActivityEvent => ({
  id,
  timestamp: second * 1_000,
  kind: "window-focus",
  appName,
  title,
  platform: "win32",
});

describe("Work Trace Engine", () => {
  it("backtracks from the current Excel window and excludes unrelated windows", () => {
    const events = [
      event("request", 0, "Microsoft Teams", "6월 실제 인건비 확인 요청"),
      event("browser", 1, "Chrome", "사내 포털"),
      event("sheet", 2, "Microsoft Excel", "6월_인건비마감.xlsx"),
      event("search", 3, "Chrome", "회의실 위치 검색"),
      event("meeting", 4, "Microsoft Outlook", "주간 사업 리뷰"),
      event("notes", 5, "Notepad", "개인 메모"),
      event("return", 6, "Microsoft Excel", "6월_인건비마감.xlsx"),
    ];
    const anchors: WorkTraceAnchor[] = [
      {
        eventId: "request",
        action: "artifact-invoked",
        source: "uia-invoke",
        artifactFingerprint: "sharepoint:item-204",
      },
      {
        eventId: "sheet",
        action: "artifact-opened",
        source: "office-adapter",
        artifactFingerprint: "sharepoint:item-204",
      },
      {
        eventId: "meeting",
        action: "notification-opened",
        source: "notification",
      },
    ];

    const { graph, slice } = traceCurrentWork({
      events,
      anchors,
      current: events.at(-1),
    });

    expect(slice).toMatchObject({
      rootEvidenceId: "request",
      currentEvidenceId: "return",
      workEvidenceIds: ["request", "sheet", "return"],
      detourEvidenceIds: ["meeting"],
      excludedEvidenceIds: ["browser", "search", "notes"],
      excludedEventCount: 3,
      confidence: "exact",
    });
    expect(slice?.proof.map(({ kind }) => kind)).toEqual([
      "same-artifact",
      "time",
      "exact-return",
    ]);
    expect(canUseWorkTraceForModel(slice)).toBe(true);
    expect(
      graph.spans
        .filter(({ eventId }) => ["request", "sheet", "return"].includes(eventId))
        .map(({ traceId }) => traceId),
    ).toEqual([slice?.traceId, slice?.traceId, slice?.traceId]);
  });

  it("uses a distinctive shared title anchor when no app adapter is available", () => {
    const events = [
      event("search", 0, "File Explorer", "Evaluation results"),
      event("sheet", 1, "Microsoft Excel", "result_0723.xlsx"),
      event("slack", 2, "Slack", "A sample results?"),
      event("return", 3, "Microsoft Excel", "result_0723.xlsx"),
    ];
    const { slice } = traceCurrentWork({ events, current: events.at(-1) });

    expect(slice).toMatchObject({
      rootEvidenceId: "search",
      workEvidenceIds: ["search", "sheet", "return"],
      detourEvidenceIds: ["slack"],
      excludedEvidenceIds: [],
      confidence: "supported",
    });
    expect(slice?.proof.some(({ kind }) => kind === "shared-anchor")).toBe(true);
    expect(canUseWorkTraceForModel(slice)).toBe(false);
  });

  it("does not join work based only on a common month token", () => {
    const events = [
      event("chat", 0, "Teams", "6월 복지 행사"),
      event("sheet", 1, "Excel", "6월_인건비.xlsx"),
    ];
    const graph = buildWorkTraceGraph({ events });
    expect(graph.spans[0].traceId).not.toBe(graph.spans[1].traceId);
    expect(sliceCurrentWork(graph)?.rootEvidenceId).toBe("sheet");
    expect(canUseWorkTraceForModel(sliceCurrentWork(graph))).toBe(false);
  });

  it("ignores protected gaps because they cannot become causal evidence", () => {
    const first = event("first", 0, "Excel", "Q3.xlsx");
    const gap: ActivityEvent = {
      id: "gap",
      kind: "capture-gap",
      gapReason: "protected",
      timestamp: 1_000,
      platform: "win32",
    };
    const returned = event("return", 2, "Excel", "Q3.xlsx");
    const { graph, slice } = traceCurrentWork({
      events: [first, gap, returned],
      current: returned,
    });
    expect(graph.eventOrder).toEqual(["first", "return"]);
    expect(slice?.workEvidenceIds).toEqual(["first", "return"]);
    expect(slice?.detourEvidenceIds).toEqual([]);
    expect(canUseWorkTraceForModel(slice)).toBe(false);
  });

  it("selects three causal events and excludes seventeen unrelated windows", () => {
    const request = event(
      "request",
      0,
      "Microsoft Teams",
      "SKA-204 투자비 검토 자료",
    );
    const sheet = event(
      "sheet",
      1,
      "Microsoft Excel",
      "SKA-204_투자비검토.xlsx",
    );
    const unrelated = Array.from({ length: 17 }, (_, index) =>
      event(
        `noise-${index + 1}`,
        index + 2,
        index % 2 ? "Chrome" : "Notepad",
        `관련 없는 창 ${index + 1}`,
      ),
    );
    const returned = event(
      "return",
      19,
      "Microsoft Excel",
      "SKA-204_투자비검토.xlsx",
    );
    const anchors: WorkTraceAnchor[] = [
      {
        eventId: request.id,
        action: "artifact-invoked",
        source: "uia-invoke",
        artifactFingerprint: "sharepoint:ska-204",
      },
      {
        eventId: sheet.id,
        action: "artifact-opened",
        source: "office-adapter",
        artifactFingerprint: "sharepoint:ska-204",
      },
    ];
    const events = [request, sheet, ...unrelated, returned];
    const { slice } = traceCurrentWork({
      events,
      anchors,
      current: returned,
    });

    expect(events).toHaveLength(20);
    expect(slice?.workEvidenceIds).toEqual(["request", "sheet", "return"]);
    expect(slice?.excludedEventCount).toBe(17);
    expect(slice?.excludedEvidenceIds).toEqual(
      unrelated.map(({ id }) => id),
    );
    expect(canUseWorkTraceForModel(slice)).toBe(true);
  });
});
