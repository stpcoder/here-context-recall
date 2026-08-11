import { describe, expect, it } from "vitest";
import type { ActivityEvent, RecallState } from "../electron/shared/contracts";
import { buildContextJourney } from "./context-journey";

const at = (minute: number) => minute * 60_000;
const event = (id: string, minute: number, appName: string, title: string): ActivityEvent => ({
  id,
  timestamp: at(minute),
  kind: "window-focus",
  appName,
  title,
  platform: "win32",
});

it("labels the observed chronology as before, opened, away, and now", () => {
  const events = [
    event("chat", 31, "Teams", "Q3 예산안 숫자 확인 요청"),
    event("folder", 32, "File Explorer", "재무팀 > 3분기 보고"),
    event("sheet", 33, "Microsoft Excel", "Q3_예산검토.xlsx"),
    event("mail", 34, "Microsoft Outlook", "오후 회의 일정"),
    event("return", 36, "Microsoft Excel", "Q3_예산검토.xlsx"),
  ];
  const state: RecallState = {
    status: "ready",
    current: events.at(-1),
    updatedAt: at(36),
    explanation: {
      answer: "Q3 예산안 숫자를 확인하던 중이었습니다.",
      interrupted: true,
      evidenceIds: events.map(({ id }) => id),
      chain: events.map((item, index) => ({
        eventId: item.id,
        timestamp: item.timestamp,
        label: `${item.appName} — ${item.title}`,
        role:
          index === 3
            ? "interruption"
            : index === 4
              ? "return"
              : "context",
      })),
    },
  };

  expect(buildContextJourney(state).map(({ phaseLabel }) => phaseLabel)).toEqual([
    "출발",
    "이동",
    "이 창을 열음",
    "다른 창",
    "지금 복귀",
  ]);
});

describe("journey fallback", () => {
  it("still identifies the current window without a causal chain", () => {
    const current = event("current", 4, "Microsoft Excel", "budget.xlsx");
    expect(
      buildContextJourney({ status: "ready", current, updatedAt: at(4) }),
    ).toMatchObject([
      { app: "Microsoft Excel", detail: "budget.xlsx", phaseLabel: "지금" },
    ]);
  });
});
