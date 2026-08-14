import type { ActivityEvent } from "../shared/contracts";

export type TransitionRelation = "continue" | "interrupt" | "return" | "new";
export type TraceEvidenceStrength = "exact" | "strong" | "supporting";
export type TraceConfidence = "exact" | "supported" | "uncertain";

export type WorkTraceAnchor = {
  eventId: string;
  action:
    | "request-opened"
    | "artifact-invoked"
    | "artifact-opened"
    | "selection-changed"
    | "notification-opened";
  source:
    | "window"
    | "notification"
    | "uia-invoke"
    | "graph"
    | "office-adapter";
  /** A local hash or stable organizational resource id. Never file contents. */
  artifactFingerprint?: string;
  titleAnchors?: string[];
  location?: {
    document: string;
    section?: string;
    position?: string;
  };
};

export type WorkTraceSpan = {
  spanId: string;
  eventId: string;
  traceId: string;
  parentSpanId?: string;
  app: string;
  title?: string;
  windowFingerprint: string;
  titleAnchors: string[];
  artifactFingerprint?: string;
  startedAt: number;
  endedAt?: number;
};

export type TraceEdgeEvidence = {
  id: string;
  kind:
    | "same-artifact"
    | "exact-return"
    | "new-window"
    | "time"
    | "shared-anchor";
  strength: TraceEvidenceStrength;
  detail?: string;
};

export type WorkTraceEdge = {
  edgeId: string;
  fromSpanId: string;
  toSpanId: string;
  relation: TransitionRelation;
  evidence: TraceEdgeEvidence[];
};

export type WorkTraceGraph = {
  spans: WorkTraceSpan[];
  edges: WorkTraceEdge[];
  anchors: WorkTraceAnchor[];
  eventOrder: string[];
};

export type WorkTraceSlice = {
  traceId: string;
  currentEvidenceId: string;
  rootEvidenceId: string;
  workEvidenceIds: string[];
  detourEvidenceIds: string[];
  excludedEvidenceIds: string[];
  excludedEventCount: number;
  confidence: TraceConfidence;
  proof: TraceEdgeEvidence[];
};

export type WorkTraceQuery = {
  events: ActivityEvent[];
  anchors?: WorkTraceAnchor[];
  current?: ActivityEvent;
};

const MAX_STRONG_LINK_GAP_MS = 5_000;
const MAX_CANDIDATES = 12;
const GENERIC_TOKENS = new Set([
  "app",
  "file",
  "microsoft",
  "document",
  "window",
  "문서",
  "파일",
  "열기",
  "요청",
  "확인",
  "현재",
  "작업",
]);

/**
 * Turns foreground-window observations into a small causality graph. Exact
 * document returns and identical artifacts are resolved locally. Semantic
 * model calls can be layered on top later for the remaining ambiguous edges.
 */
export function buildWorkTraceGraph({
  events,
  anchors = [],
}: Pick<WorkTraceQuery, "events" | "anchors">): WorkTraceGraph {
  const chronological = [...events].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const orderedEvents = chronological.filter(
    (event) => event.kind === "window-focus",
  );
  const anchorByEvent = new Map(anchors.map((anchor) => [anchor.eventId, anchor]));
  const spans: WorkTraceSpan[] = [];
  const edges: WorkTraceEdge[] = [];
  let traceSequence = 0;

  for (const event of orderedEvents) {
    const anchor = anchorByEvent.get(event.id);
    const titleAnchors = unique([
      ...extractTitleAnchors(event.title),
      ...(anchor?.titleAnchors ?? []).flatMap(extractTitleAnchors),
    ]);
    const base: Omit<WorkTraceSpan, "traceId"> = {
      spanId: `span:${event.id}`,
      eventId: event.id,
      app: event.appName ?? "Unknown app",
      title: event.title,
      windowFingerprint: fingerprintWindow(event),
      titleAnchors,
      artifactFingerprint: normalizeFingerprint(anchor?.artifactFingerprint),
      startedAt: event.timestamp,
      endedAt: event.lastSeenAt,
    };
    const previousSpan = spans.at(-1);
    const hasPrivateBoundary = Boolean(
      previousSpan &&
      chronological.some(
        (candidate) =>
          candidate.timestamp > previousSpan.startedAt &&
          candidate.timestamp < event.timestamp &&
          candidate.kind === "capture-gap",
      ),
    );
    const exactReturn = findExactReturn(
      spans,
      base.windowFingerprint,
      hasPrivateBoundary,
    );
    const sameArtifact = exactReturn
      ? undefined
      : findSameArtifact(spans, base.artifactFingerprint);
    const strongCandidate = exactReturn || sameArtifact
      ? undefined
      : findStrongCandidate(spans, base);
    const parent = exactReturn ?? sameArtifact ?? strongCandidate;
    const relation: TransitionRelation = exactReturn
      ? "return"
      : parent
        ? "continue"
        : "new";
    const traceId = parent?.traceId ?? `trace:${++traceSequence}`;
    const span: WorkTraceSpan = {
      ...base,
      traceId,
      parentSpanId: parent?.spanId,
    };
    spans.push(span);

    if (parent) {
      edges.push({
        edgeId: `edge:${parent.eventId}:${event.id}`,
        fromSpanId: parent.spanId,
        toSpanId: span.spanId,
        relation,
        evidence: relationEvidence(parent, span, relation),
      });
    } else if (spans.length > 1) {
      const previous = spans.at(-2)!;
      edges.push({
        edgeId: `edge:${previous.eventId}:${event.id}`,
        fromSpanId: previous.spanId,
        toSpanId: span.spanId,
        relation: "new",
        evidence: timeEvidence(previous, span, "별도 업무 후보"),
      });
    }
  }

  return {
    spans,
    edges,
    anchors,
    eventOrder: orderedEvents.map(({ id }) => id),
  };
}

/** Selects only the events that can affect the current window. */
export function sliceCurrentWork(
  graph: WorkTraceGraph,
  currentEventId = graph.eventOrder.at(-1),
): WorkTraceSlice | undefined {
  if (!currentEventId) return undefined;
  const current = graph.spans.find((span) => span.eventId === currentEventId);
  if (!current) return undefined;
  const workSpans = graph.spans.filter((span) => span.traceId === current.traceId);
  const workIds = new Set(workSpans.map((span) => span.eventId));
  const currentIndex = graph.spans.indexOf(current);
  const returnEdge = [...graph.edges]
    .reverse()
    .find(
      (edge) =>
        edge.relation === "return" &&
        graph.spans.find((span) => span.spanId === edge.toSpanId)?.traceId ===
          current.traceId &&
        graph.spans.indexOf(
          graph.spans.find((span) => span.spanId === edge.toSpanId)!,
        ) <= currentIndex,
    );
  const detourIds = new Set<string>();

  if (returnEdge) {
    const fromIndex = graph.spans.findIndex(
      (span) => span.spanId === returnEdge.fromSpanId,
    );
    const toIndex = graph.spans.findIndex(
      (span) => span.spanId === returnEdge.toSpanId,
    );
    const between = graph.spans.slice(fromIndex + 1, toIndex);
    const explicitDetours = between.filter((span) =>
      graph.anchors.some(
        (anchor) =>
          anchor.eventId === span.eventId &&
          anchor.action === "notification-opened",
      ),
    );
    // A single closed A → B → A segment is deterministic even without an app
    // adapter. With several branches, only explicitly observed notifications
    // are shown and all other windows remain excluded.
    const selected = explicitDetours.length
      ? explicitDetours
      : between.length === 1
        ? between
        : [];
    selected.forEach((span) => detourIds.add(span.eventId));
  }

  const excludedEvidenceIds = graph.eventOrder.filter(
    (id) => !workIds.has(id) && !detourIds.has(id),
  );
  const traceEdges = graph.edges.filter((edge) => {
    const target = graph.spans.find((span) => span.spanId === edge.toSpanId);
    return target?.traceId === current.traceId;
  });
  const proof = uniqueEvidence(traceEdges.flatMap((edge) => edge.evidence));
  const root = workSpans[0] ?? current;

  return {
    traceId: current.traceId,
    currentEvidenceId: current.eventId,
    rootEvidenceId: root.eventId,
    workEvidenceIds: workSpans.map((span) => span.eventId),
    detourEvidenceIds: graph.eventOrder.filter((id) => detourIds.has(id)),
    excludedEvidenceIds,
    excludedEventCount: excludedEvidenceIds.length,
    confidence: traceConfidence(traceEdges, workSpans),
    proof,
  };
}

export function traceCurrentWork(query: WorkTraceQuery): {
  graph: WorkTraceGraph;
  slice?: WorkTraceSlice;
} {
  const graph = buildWorkTraceGraph(query);
  return {
    graph,
    slice: sliceCurrentWork(graph, query.current?.id),
  };
}

/**
 * Runtime filtering is deliberately stricter than diagnostics. Only a stable
 * resource identity may remove events from the model request. Title anchors
 * remain useful for review, but cannot silently narrow evidence on their own.
 */
export function canUseWorkTraceForModel(slice?: WorkTraceSlice): boolean {
  if (!slice || slice.confidence === "uncertain") return false;
  const foundExactOrigin = slice.proof.some(
    ({ kind }) => kind === "same-artifact",
  );
  return foundExactOrigin && slice.workEvidenceIds.length >= 2;
}

function findExactReturn(
  spans: WorkTraceSpan[],
  windowFingerprint: string,
  hasPrivateBoundary = false,
): WorkTraceSpan | undefined {
  if (!spans.length) return undefined;
  const latest = spans.at(-1);
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const candidate = spans[index];
    if (candidate.windowFingerprint !== windowFingerprint) continue;
    if (
      latest?.windowFingerprint === windowFingerprint &&
      !hasPrivateBoundary
    ) return undefined;
    return candidate;
  }
  return undefined;
}

function findSameArtifact(
  spans: WorkTraceSpan[],
  artifactFingerprint?: string,
): WorkTraceSpan | undefined {
  if (!artifactFingerprint) return undefined;
  return [...spans]
    .reverse()
    .find((span) => span.artifactFingerprint === artifactFingerprint);
}

function findStrongCandidate(
  spans: WorkTraceSpan[],
  current: Omit<WorkTraceSpan, "traceId">,
): WorkTraceSpan | undefined {
  for (const candidate of spans.slice(-MAX_CANDIDATES).reverse()) {
    if (current.startedAt - candidate.startedAt > MAX_STRONG_LINK_GAP_MS) break;
    // Title similarity is only a safe directional hint when a request/search
    // surface is followed by a work artifact. A document → chat transition is
    // an interruption unless an adapter supplies exact artifact evidence.
    if (!isEntryTransition(candidate.app, current.app)) continue;
    const shared = intersection(candidate.titleAnchors, current.titleAnchors);
    if (shared.length >= 2 || shared.some(isDistinctiveAnchor)) return candidate;
  }
  return undefined;
}

function isEntryTransition(fromApp: string, toApp: string): boolean {
  const from = normalize(fromApp);
  const to = normalize(toApp);
  const isSource = /teams|slack|outlook|mail|explorer|finder|browser|chrome|edge|safari/.test(from);
  const isArtifact = /excel|word|powerpoint|acrobat|pdf|notepad|editor|code|explorer|finder/.test(to);
  return isSource && isArtifact;
}

function relationEvidence(
  parent: WorkTraceSpan,
  current: WorkTraceSpan,
  relation: TransitionRelation,
): TraceEdgeEvidence[] {
  if (relation === "return") {
    return [
      {
        id: `proof:return:${parent.eventId}:${current.eventId}`,
        kind: "exact-return",
        strength: "exact",
        detail: "같은 앱과 문서 제목의 창으로 복귀",
      },
    ];
  }
  if (
    parent.artifactFingerprint &&
    parent.artifactFingerprint === current.artifactFingerprint
  ) {
    return [
      {
        id: `proof:artifact:${parent.eventId}:${current.eventId}`,
        kind: "same-artifact",
        strength: "exact",
        detail: "동일한 로컬 해시 또는 조직 자원 ID",
      },
      ...timeEvidence(parent, current, "파일 전달 직후 새 창"),
    ];
  }
  const shared = intersection(parent.titleAnchors, current.titleAnchors);
  return [
    {
      id: `proof:anchor:${parent.eventId}:${current.eventId}`,
      kind: "shared-anchor",
      strength: "strong",
      detail: shared.join(", "),
    },
    ...timeEvidence(parent, current, "짧은 시간 안에 이어진 창"),
  ];
}

function timeEvidence(
  parent: WorkTraceSpan,
  current: WorkTraceSpan,
  detail: string,
): TraceEdgeEvidence[] {
  return [
    {
      id: `proof:time:${parent.eventId}:${current.eventId}`,
      kind: "time",
      strength: "supporting",
      detail: `${Math.max(0, current.startedAt - parent.startedAt)}ms · ${detail}`,
    },
  ];
}

function traceConfidence(
  edges: WorkTraceEdge[],
  spans: WorkTraceSpan[],
): TraceConfidence {
  if (spans.length < 2) return "uncertain";
  const hasSameArtifact = edges.some((edge) =>
    edge.evidence.some((item) => item.kind === "same-artifact"),
  );
  const hasExactReturn = edges.some((edge) =>
    edge.evidence.some((item) => item.kind === "exact-return"),
  );
  if (hasSameArtifact && hasExactReturn) return "exact";
  if (hasSameArtifact || hasExactReturn || edges.some((edge) =>
    edge.evidence.some((item) => item.strength === "strong"),
  )) return "supported";
  return "uncertain";
}

function fingerprintWindow(event: ActivityEvent): string {
  const app = normalize(event.appName);
  if (!event.titleRedacted && event.title)
    return `${app}|title:${normalizeTitle(event.title)}`;
  if (event.windowId) return `${app}|window:${event.windowId}`;
  return `${app}|redacted`;
}

function extractTitleAnchors(value?: string): string[] {
  if (!value) return [];
  return unique(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\.(xlsx?|xlsm|docx?|pptx?|pdf|csv|txt)\b/g, " ")
      .replace(/([a-z])([0-9])/g, "$1$2 ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .map(stemToken)
      .filter((token) => token.length >= 2 && !GENERIC_TOKENS.has(token)),
  );
}

function stemToken(token: string): string {
  if (/^[a-z]{5,}s$/.test(token)) return token.slice(0, -1);
  return token;
}

function isDistinctiveAnchor(token: string): boolean {
  return /[a-z]\d|\d[a-z]/i.test(token) || /^[a-z]{5,}$/.test(token) || /^[가-힣]{3,}$/.test(token);
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^\*+/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function normalize(value?: string): string {
  return value?.normalize("NFKC").trim().toLocaleLowerCase() ?? "";
}

function normalizeFingerprint(value?: string): string | undefined {
  const result = normalize(value);
  return result || undefined;
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueEvidence(values: TraceEdgeEvidence[]): TraceEdgeEvidence[] {
  const byId = new Map(values.map((value) => [value.id, value]));
  return [...byId.values()];
}
