import type {
  ActivityEvent,
  CausalExplanation,
  CausalQuery,
  CausalStep,
} from "../shared/contracts";

const MAX_CHAIN_STEPS = 5;
const INACTIVITY_BOUNDARY_MS = 4 * 60 * 1_000;

const isWindowEvent = (event: ActivityEvent): boolean =>
  event.kind === "window-focus";

function label(event: ActivityEvent): string {
  if (event.kind === "capture-gap")
    return event.gapReason === "protected"
      ? "보호된 창 — 내용 기록 안 함"
      : "확인할 수 없는 구간 — 내용 기록 안 함";
  const app = event.appName ?? "Unknown app";
  return event.title ? `${app} — ${event.title}` : app;
}

function sameTarget(left: ActivityEvent, right: ActivityEvent): boolean {
  if (!left.appName || !right.appName) return false;
  if (normalizeTitle(left.appName) !== normalizeTitle(right.appName)) return false;

  // A single browser or Office HWND can host several tabs/documents. Visible
  // titles therefore take precedence over the native handle when available.
  if (!left.titleRedacted && !right.titleRedacted && left.title && right.title)
    return normalizeTitle(left.title) === normalizeTitle(right.title);
  if (left.windowId && right.windowId) return left.windowId === right.windowId;
  // For redacted titles, the app identity is the only privacy-preserving signal.
  return Boolean(left.titleRedacted || right.titleRedacted);
}

function normalizeTitle(value: string): string {
  return value
    .trim()
    .replace(/^\*+/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

/**
 * Selects a bounded, rule-based work segment before any model is called.
 * Human pause/resume is a hard boundary, a long observation gap is a soft
 * boundary, and an observed A → non-A → A return can bridge that soft gap.
 */
export function explainCausalChain(query: CausalQuery): CausalExplanation {
  const events = [...query.events].sort((a, b) => a.timestamp - b.timestamp);
  const latest = events.at(-1);
  const current =
    query.current ?? (latest?.kind === "window-focus" ? latest : undefined);
  if (!current) return emptyExplanation();

  const end = findEventIndex(events, current);
  if (end < 0) events.push(current);
  const currentIndex = end < 0 ? events.length - 1 : end;
  const explicitBoundary = findExplicitBoundary(events, currentIndex);
  const minimumIndex = explicitBoundary === undefined ? 0 : explicitBoundary + 1;
  const returnIndex = findReturn(events, currentIndex, current, minimumIndex);

  let segmentStart = minimumIndex;
  let boundary: CausalExplanation["boundary"] = explicitBoundary === undefined
    ? { reason: "recent-window" }
    : { reason: "explicit-resume", at: events[explicitBoundary].timestamp };
  if (returnIndex !== undefined) {
    segmentStart = minimumIndex;
    boundary = { reason: "return-chain", at: events[returnIndex].timestamp };
  } else {
    const inactivityStart = findInactivityBoundary(
      events,
      currentIndex,
      minimumIndex,
    );
    if (inactivityStart !== undefined) {
      segmentStart = inactivityStart;
      boundary = { reason: "inactivity", at: events[inactivityStart].timestamp };
    }
  }

  const selectedIndexes = selectIndexes(
    events,
    currentIndex,
    segmentStart,
    returnIndex,
  );
  const chain: CausalStep[] = selectedIndexes.map((actualIndex) => {
    const event = events[actualIndex];
    const role: CausalStep["role"] =
      actualIndex === currentIndex
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
  const originEvent = returnIndex === undefined
    ? selectedIndexes
        .slice(0, -1)
        .reverse()
        .map((index) => events[index])
        .find(isWindowEvent)
    : events[returnIndex];
  const interrupted = returnIndex !== undefined;
  const answer = interrupted
    ? `${label(current)} 창으로 돌아왔어요. 중간에 다른 창을 사용했습니다.`
    : originEvent
      ? `${label(originEvent)} 다음에 ${label(current)} 창을 열었어요.`
      : `지금 ${label(current)} 창을 사용하고 있어요.`;
  const focusCount = selectedIndexes.filter((index) => isWindowEvent(events[index])).length;
  const hasObservedInterruption =
    returnIndex !== undefined &&
    events
      .slice(returnIndex + 1, currentIndex)
      .some((event) => event.kind === "window-focus");
  const confidence: CausalExplanation["confidence"] = hasObservedInterruption
    ? "high"
    : focusCount >= 2
      ? "medium"
      : "low";

  return {
    answer,
    origin: originEvent ? label(originEvent) : undefined,
    nextAction: `${label(current)}에서 계속하기`,
    chain,
    evidenceIds: chain.map((step) => step.eventId),
    interrupted,
    confidence,
    boundary,
  };
}

function emptyExplanation(): CausalExplanation {
  return {
    answer: "최근에 사용한 창이 없습니다.",
    chain: [],
    evidenceIds: [],
    interrupted: false,
    confidence: "low",
    boundary: { reason: "recent-window" },
  };
}

function findEventIndex(events: ActivityEvent[], current: ActivityEvent): number {
  for (let index = events.length - 1; index >= 0; index -= 1)
    if (events[index].id === current.id) return index;
  return -1;
}

function findExplicitBoundary(
  events: ActivityEvent[],
  end: number,
): number | undefined {
  for (let index = end - 1; index >= 0; index -= 1)
    if (events[index].kind === "monitor-resumed") return index;
  return undefined;
}

function findInactivityBoundary(
  events: ActivityEvent[],
  end: number,
  minimum: number,
): number | undefined {
  for (let index = end; index > minimum; index -= 1) {
    const previous = events[index - 1];
    const previousEnd = previous.lastSeenAt ?? previous.timestamp;
    if (events[index].timestamp - previousEnd >= INACTIVITY_BOUNDARY_MS)
      return index;
  }
  return undefined;
}

function selectIndexes(
  events: ActivityEvent[],
  end: number,
  start: number,
  returnIndex: number | undefined,
): number[] {
  const candidates = Array.from(
    { length: Math.max(0, end - start + 1) },
    (_, offset) => start + offset,
  ).filter((index) =>
    events[index].kind === "window-focus" || events[index].kind === "capture-gap",
  );
  if (returnIndex === undefined) return candidates.slice(-MAX_CHAIN_STEPS);

  const indexes = new Set<number>();
  indexes.add(returnIndex);
  const interruptions = candidates.filter(
    (index) => index > returnIndex && index < end,
  );
  if (interruptions[0] !== undefined) indexes.add(interruptions[0]);
  if (interruptions.length > 1) indexes.add(interruptions.at(-1)!);
  indexes.add(end);
  const remainingContextSlots = Math.max(0, MAX_CHAIN_STEPS - indexes.size);
  for (const index of candidates
    .filter((candidate) => candidate < returnIndex)
    .slice(-remainingContextSlots))
    indexes.add(index);
  return [...indexes].sort((a, b) => a - b).slice(-MAX_CHAIN_STEPS);
}

function findReturn(
  events: ActivityEvent[],
  end: number,
  current: ActivityEvent,
  minimum: number,
): number | undefined {
  // An interruption is proven only by A → non-A/protected gap → A.
  for (let index = end - 1; index >= minimum; index -= 1) {
    if (events[index].kind !== "window-focus") continue;
    if (!sameTarget(events[index], current)) continue;
    if (
      events.slice(index + 1, end).some(
        (event) =>
          event.kind === "capture-gap" ||
          (event.kind === "window-focus" && !sameTarget(event, current)),
      )
    )
      return index;
  }
  return undefined;
}
