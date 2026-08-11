import type {
  ActivityEvent,
  CausalExplanation,
  CausalQuery,
  CausalStep,
} from "../shared/contracts";

const WINDOW_EVENT = (event: ActivityEvent): boolean =>
  event.kind === "window-focus";

function label(event: ActivityEvent): string {
  const app = event.appName ?? "Unknown app";
  return event.title ? `${app} — ${event.title}` : app;
}

function sameTarget(left: ActivityEvent, right: ActivityEvent): boolean {
  if (!left.appName || !right.appName || left.appName !== right.appName)
    return false;
  if (left.windowId && right.windowId) return left.windowId === right.windowId;
  // For redacted titles, the app identity is the only privacy-preserving signal.
  if (left.titleRedacted || right.titleRedacted) return true;
  return Boolean(
    left.title &&
      right.title &&
      normalizeTitle(left.title) === normalizeTitle(right.title),
  );
}

function normalizeTitle(value: string): string {
  return value
    .trim()
    .replace(/^\*+/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

/**
 * Turns focus observations into a compact explanation.  It does not invent
 * user intent: every statement maps to an event id returned as evidence.
 */
export function explainCausalChain(query: CausalQuery): CausalExplanation {
  const events = query.events
    .filter(WINDOW_EVENT)
    .sort((a, b) => a.timestamp - b.timestamp);
  const current = query.current ?? events.at(-1);
  if (!current) {
    return {
      answer: "아직 관측된 창이 없습니다.",
      chain: [],
      evidenceIds: [],
      interrupted: false,
    };
  }

  let currentIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].id === current.id) {
      currentIndex = index;
      break;
    }
  }
  const end = currentIndex >= 0 ? currentIndex : events.length - 1;
  const returnIndex = findReturn(events, end, current);
  const selectedIndexes = selectIndexes(events, end, returnIndex);
  const selected = selectedIndexes.map((index) => events[index]);

  const chain: CausalStep[] = selected.map((event, index) => {
    const actualIndex = selectedIndexes[index];
    const role: CausalStep["role"] =
      actualIndex === end
        ? returnIndex !== undefined
          ? "return"
          : "target"
        : returnIndex !== undefined && actualIndex > returnIndex
          ? "interruption"
          : "context";
    return {
      eventId: event.id,
      timestamp: event.timestamp,
      label: label(event),
      role,
    };
  });
  const originEvent =
    returnIndex === undefined ? selected.at(-2) : events[returnIndex];
  const interrupted = returnIndex !== undefined;
  const answer = interrupted
    ? `현재 ${label(current)} 창으로 다시 돌아왔습니다. 중간에 다른 앱 전환이 있었습니다.`
    : originEvent
      ? `현재 ${label(current)} 창은 직전 ${label(originEvent)} 뒤에 열렸습니다.`
      : `현재 ${label(current)} 창이 관측되었습니다.`;

  return {
    answer,
    origin: originEvent ? label(originEvent) : undefined,
    nextAction: `현재 창(${label(current)})에서 계속하기`,
    chain,
    evidenceIds: chain.map((step) => step.eventId),
    interrupted,
  };
}

function selectIndexes(
  events: ActivityEvent[],
  end: number,
  returnIndex: number | undefined,
): number[] {
  if (returnIndex === undefined) {
    return Array.from(
      { length: Math.min(5, end + 1) },
      (_, offset) => end - Math.min(4, end) + offset,
    );
  }
  const indexes = new Set<number>();
  if (returnIndex > 0) indexes.add(returnIndex - 1);
  indexes.add(returnIndex);
  const interruptionIndexes = Array.from(
    { length: Math.max(0, end - returnIndex - 1) },
    (_, offset) => returnIndex + 1 + offset,
  );
  // Preserve the first and most recent interruption when many windows were crossed.
  if (interruptionIndexes.length > 0) indexes.add(interruptionIndexes[0]);
  if (interruptionIndexes.length > 1) indexes.add(interruptionIndexes.at(-1)!);
  indexes.add(end);
  return [...indexes].sort((a, b) => a - b).slice(-5);
}

function findReturn(
  events: ActivityEvent[],
  end: number,
  current: ActivityEvent,
): number | undefined {
  // An interruption is only proven by A → non-A → A, never by app category guesses.
  for (let index = end - 2; index >= 0; index -= 1) {
    if (!sameTarget(events[index], current)) continue;
    if (
      events.slice(index + 1, end).some((event) => !sameTarget(event, current))
    )
      return index;
  }
  return undefined;
}
