import type { ActivityEvent, CausalStep, RecallState } from "../electron/shared/contracts";

export type JourneyPhase = "before" | "opened" | "away" | "now";

export interface JourneyMoment {
  eventId: string;
  timestamp: number;
  app: string;
  detail: string;
  phase: JourneyPhase;
  phaseLabel: string;
}

function splitStep(step: CausalStep): { app: string; detail: string } {
  const [app, ...detail] = step.label.split(" — ");
  return {
    app: app || "알 수 없는 앱",
    detail: detail.join(" — ") || "창 제목 없음",
  };
}

function currentStep(event: ActivityEvent): CausalStep {
  const app = event.appName || "알 수 없는 앱";
  const detail = event.titleRedacted
    ? "제목은 가려짐"
    : event.title || "창 제목 없음";
  return {
    eventId: event.id,
    timestamp: event.timestamp,
    label: `${app} — ${detail}`,
    role: "target",
  };
}

export function buildContextJourney(state: RecallState): JourneyMoment[] {
  const chain = state.explanation?.chain.length
    ? state.explanation.chain
    : state.current
      ? [currentStep(state.current)]
      : [];
  const firstAway = chain.findIndex((step) => step.role === "interruption");
  const openedIndex = firstAway > 0 ? firstAway - 1 : -1;

  return chain.map((step, index) => {
    const { app, detail } = splitStep(step);
    let phase: JourneyPhase = "before";
    let phaseLabel = index === 0 ? "출발" : "이동";

    if (step.role === "interruption") {
      phase = "away";
      phaseLabel = "다른 창";
    } else if (step.role === "return" || step.role === "target") {
      phase = "now";
      phaseLabel = step.role === "return" ? "지금 복귀" : "지금";
    } else if (index === openedIndex) {
      phase = "opened";
      phaseLabel = "이 창을 열음";
    }

    return {
      eventId: step.eventId,
      timestamp: step.timestamp,
      app,
      detail,
      phase,
      phaseLabel,
    };
  });
}

export function interruptionSummary(state: RecallState): string | undefined {
  const journey = buildContextJourney(state);
  const opened = journey.find((moment) => moment.phase === "opened");
  const returned = journey.find((moment) => moment.phase === "now");
  if (!opened || !returned || !journey.some((moment) => moment.phase === "away"))
    return undefined;
  const minutes = Math.max(
    1,
    Math.round((returned.timestamp - opened.timestamp) / 60_000),
  );
  return `다른 창으로 이동 · ${minutes}분 뒤 복귀`;
}
