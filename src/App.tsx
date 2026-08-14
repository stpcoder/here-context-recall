import { AnimatePresence, motion } from "framer-motion";
import {
  AppWindow,
  ArrowRight,
  Bookmark,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FolderOpen,
  LoaderCircle,
  Mail,
  MessageSquare,
  Server,
  Settings2,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ActivityEvent,
  CheckpointState,
  DesktopBootstrap,
  HereDesktopApi,
  ModelProvider,
  PublicSettings,
  RecallState,
} from "../electron/shared/contracts";
import {
  buildContextJourney,
  type JourneyMoment,
} from "./context-journey";
import DemoWorkspace from "./DemoWorkspace";
import { createShowcaseApi } from "./showcase-api";

type Surface = "bubble" | "recall" | "settings" | "trace";

const query = new URLSearchParams(window.location.search);
const demo = import.meta.env.DEV && query.get("demo") === "1";
const showcase =
  import.meta.env.DEV && (query.get("showcase") === "1" || demo);
if (showcase && query.get("captureScale")) {
  const scale = Math.max(1, Math.min(3, Number(query.get("captureScale")) || 1));
  const isBubbleCapture = query.get("surface") === "bubble";
  const width = Math.max(isBubbleCapture ? 1 : 320, Number(query.get("captureWidth")) || 860);
  const height = Math.max(isBubbleCapture ? 1 : 320, Number(query.get("captureHeight")) || 540);
  document.documentElement.dataset.showcaseCapture = "true";
  document.documentElement.style.setProperty("--showcase-scale", String(scale));
  document.documentElement.style.setProperty("--showcase-width", `${width}px`);
  document.documentElement.style.setProperty("--showcase-height", `${height}px`);
}
function resolveApi(): HereDesktopApi {
  const bridge = window.here ?? (showcase ? createShowcaseApi() : undefined);
  if (!bridge) throw new Error("Here desktop bridge is unavailable.");
  return bridge;
}
const api = resolveApi();

function getSurface(): Surface {
  const value = new URLSearchParams(window.location.search).get("surface");
  return value === "bubble" || value === "settings" || value === "trace"
    ? value
    : "recall";
}

function clock(value?: number): string {
  if (!value) return "방금";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function moment(value?: number): string {
  if (!value) return "방금";
  const date = new Date(value);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  const prefix = days === 0 ? "오늘" : days === 1 ? "어젯밤" : `${date.getMonth() + 1}월 ${date.getDate()}일`;
  return `${prefix} ${clock(value)}`;
}

function appLabel(event?: ActivityEvent): string {
  return event?.appName || "알 수 없는 앱";
}

function shortAppLabel(event?: ActivityEvent): string {
  return appLabel(event).replace(/^Microsoft\s+/i, "");
}

function titleLabel(event?: ActivityEvent): string {
  if (!event) return "";
  return event.titleRedacted ? "제목은 가려짐" : event.title || "창 제목 없음";
}

function Mark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`here-mark ${compact ? "is-compact" : ""}`} aria-hidden="true">
      <i />
      <i />
    </span>
  );
}

function Bubble() {
  const [expanded, setExpanded] = useState(
    showcase && query.get("expanded") === "1",
  );
  const [stats, setStats] = useState<DesktopBootstrap["stats"]>();
  const [checkpoint, setCheckpoint] = useState<CheckpointState>();
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    void api.bootstrap().then((data) => {
      setStats(data.stats);
      setCheckpoint(data.checkpoint);
    });
    const stopActivity = api.onActivity((event) => {
      if (event.kind === "monitor-paused")
        setStats((current) =>
          current ? { ...current, paused: true } : current,
        );
      if (event.kind === "monitor-resumed")
        setStats((current) =>
          current ? { ...current, paused: false } : current,
        );
    });
    const stopCheckpoint = api.onCheckpoint((value) => {
      setCheckpoint(value);
      if (value.status === "saved") {
        setFlash(true);
        window.setTimeout(() => setFlash(false), 2_600);
      }
    });
    return () => {
      stopActivity();
      stopCheckpoint();
    };
  }, []);

  const change = (next: boolean) => {
    setExpanded(next);
    void api.setBubbleExpanded(next);
  };
  const label =
    checkpoint?.status === "saving"
      ? "작업 저장 중"
      : flash
        ? "작업을 저장했어요"
        : "왜 이 창을 열었지?";

  return (
    <motion.button
      className={`bubble ${expanded || flash ? "is-expanded" : ""} ${flash ? "is-saved" : ""}`}
      aria-label="왜 이 창을 열었는지 확인"
      onMouseEnter={() => change(true)}
      onMouseLeave={() => change(false)}
      onFocus={() => change(true)}
      onBlur={() => change(false)}
      onClick={() => void api.recall("bubble")}
      initial={showcase ? false : { opacity: 0, scale: 0.86 }}
      animate={{ opacity: 1, scale: 1 }}
    >
      <Mark compact />
      <span className="bubble-copy">{label}</span>
      {stats?.paused && <span className="bubble-paused">일시 정지</span>}
    </motion.button>
  );
}

function WindowIcon({ app }: { app: string }) {
  const Icon = /teams|slack|chat/i.test(app)
    ? MessageSquare
    : /explorer|finder|file/i.test(app)
      ? FolderOpen
      : /excel|sheet/i.test(app)
        ? FileSpreadsheet
        : /outlook|mail/i.test(app)
          ? Mail
          : AppWindow;
  return <Icon size={15} strokeWidth={1.8} aria-hidden="true" />;
}

function JourneyRow({ item, index }: { item: JourneyMoment; index: number }) {
  return (
    <motion.li
      className={`journey-row phase-${item.phase}`}
      initial={showcase ? false : { opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.045, duration: 0.18 }}
    >
      <time>{clock(item.timestamp)}</time>
      <span className="journey-icon"><WindowIcon app={item.app} /></span>
      <strong>{item.app}</strong>
      <p title={item.detail}>{item.detail}</p>
    </motion.li>
  );
}

function JourneyGroup({ label, items }: { label: string; items: JourneyMoment[] }) {
  if (!items.length) return null;
  return (
    <section className="journey-group">
      <h2>{label}</h2>
      <ol>
        {items.map((item, index) => <JourneyRow key={item.eventId} item={item} index={index} />)}
      </ol>
    </section>
  );
}

function JourneyTimeline({ state }: { state: RecallState }) {
  const journey = buildContextJourney(state);
  const before = journey.filter((item) => item.phase === "before" || item.phase === "opened");
  const away = journey.filter((item) => item.phase === "away");
  const current = journey.filter((item) => item.phase === "now");
  return (
    <section className="journey-card" aria-label="현재 창을 열기 전 사용한 앱과 창">
      <JourneyGroup label="이 창을 열기 전" items={before} />
      <JourneyGroup label="중간에 본 창" items={away} />
      <JourneyGroup label={state.mode === "checkpoint" ? "저장한 작업" : "지금"} items={current} />
    </section>
  );
}

function ContinueCard({
  state,
  onResume,
  onRemember,
  remembering,
}: {
  state: RecallState;
  onResume: () => void;
  onRemember: () => void;
  remembering: boolean;
}) {
  const currentTitle = titleLabel(state.current) || "현재 창";
  const nextAction = state.reconstruction?.nextAction || state.explanation?.nextAction || "현재 창에서 계속하기";
  const image = state.contextImage;
  const returnLabel = state.mode === "checkpoint"
    ? "Here 닫기"
    : `${shortAppLabel(state.current)}로 돌아가기`;
  return (
    <section className="continue-card" aria-label="현재 창과 지금 할 일">
      <div className={`window-preview ${image ? "has-image" : ""}`}>
        {image ? (
          <img src={image.dataUrl} alt="사용자가 하던 일 찾기를 누를 때 허용한 현재 창 이미지" />
        ) : (
          <div className="window-placeholder"><WindowIcon app={appLabel(state.current)} /><i /><i /><i /></div>
        )}
        <div className="window-caption">
          <span>{appLabel(state.current)}</span>
          <strong title={currentTitle}>{currentTitle}</strong>
        </div>
      </div>
      <div className="next-action-card">
        <span>지금 할 일</span>
        <strong>{nextAction}</strong>
      </div>
      <button className="primary-action continue-action" onClick={onResume}>
        {returnLabel} <ArrowRight size={17} />
      </button>
      {state.mode !== "checkpoint" && (
        <button className="remember-later-action" onClick={onRemember} disabled={remembering}>
          {remembering ? <LoaderCircle className="spinner" size={15} /> : <Bookmark size={15} />}
          {remembering ? "저장 중" : "이 작업 저장"}
        </button>
      )}
    </section>
  );
}

function EmptyState({ onRemember, onSettings }: { onRemember: () => void; onSettings: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-orbit"><Mark /></div>
      <h1>이 작업을 저장할까요?</h1>
      <p className="muted">현재 창과 다음 할 일을 저장합니다.</p>
      <div className="empty-actions">
        <button className="primary-action" onClick={onRemember}>
          <Bookmark size={16} /> 작업 저장
        </button>
        <button className="text-action" onClick={onSettings}>
          설정 <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

function RecallPanel() {
  const [state, setState] = useState<RecallState>();
  const [checkpoint, setCheckpoint] = useState<CheckpointState>();
  const refresh = useCallback(async () => {
    const boot = await api.bootstrap();
    setState(boot.recall);
    setCheckpoint(boot.checkpoint);
  }, []);

  useEffect(() => {
    void refresh();
    const stopRecall = api.onRecall(setState);
    const stopCheckpoint = api.onCheckpoint(setCheckpoint);
    return () => {
      stopRecall();
      stopCheckpoint();
    };
  }, [refresh]);

  const dismiss = () => void api.dismissRecall();
  const remember = async () => setCheckpoint(await api.remember());
  const heading = state?.reconstruction?.summary || state?.explanation?.answer;
  const hasContext = Boolean(
    state?.current || state?.explanation?.chain.length || state?.checkpoint,
  );
  const currentTitle = titleLabel(state?.current) || "현재 창";

  return (
    <main className="recall-shell">
      <header className="panel-topbar">
        <div className="wordmark"><Mark compact /><span>here</span></div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={() => void api.openSettings()} aria-label="설정 열기">
            <Settings2 size={17} />
          </button>
          <button className="icon-button" onClick={dismiss} aria-label="닫기"><X size={18} /></button>
        </div>
      </header>

      <AnimatePresence mode="wait">
        {state?.status === "loading" ? (
          <motion.section key="loading" className="recall-loading" initial={showcase ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <LoaderCircle className="spinner" size={20} />
            <p>하던 일을 찾는 중</p>
          </motion.section>
        ) : !hasContext ? (
          <motion.section key="empty" initial={showcase ? false : { opacity: 0 }} animate={{ opacity: 1 }}>
            <EmptyState onRemember={() => void remember()} onSettings={() => void api.openSettings()} />
          </motion.section>
        ) : (
          <motion.section key={`${state?.mode}-${state?.updatedAt}`} className="recall-layout" initial={showcase ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <header className="recall-intro">
              <div className="current-window-line">
                <WindowIcon app={appLabel(state?.current)} />
                <span>{shortAppLabel(state?.current)}</span>
                <strong title={currentTitle}>{currentTitle}</strong>
                {state?.mode === "checkpoint" && <time>{moment(state.checkpoint?.createdAt)} 저장</time>}
              </div>
              <h1>{heading || "이 창에서 하던 일을 찾았어요."}</h1>
            </header>
            <div className="recall-body">
              <JourneyTimeline state={state!} />
              <aside className="recall-aside">
                <ContinueCard
                  state={state!}
                  onResume={dismiss}
                  onRemember={() => void remember()}
                  remembering={checkpoint?.status === "saving"}
                />
              </aside>
            </div>
            {state?.message && <p className="error-note">{state.message}</p>}
            {checkpoint?.message && <div className={`checkpoint-note is-${checkpoint.status}`}>{checkpoint.message}</div>}
          </motion.section>
        )}
      </AnimatePresence>
    </main>
  );
}

function TraceLab() {
  const [state, setState] = useState<RecallState>();

  useEffect(() => {
    void api.bootstrap().then(({ recall }) => setState(recall));
    return api.onRecall(setState);
  }, []);

  const trace = state?.workTrace;
  const steps = state?.explanation?.chain ?? [];
  const byId = new Map(steps.map((step) => [step.eventId, step]));
  const node = (eventId: string) => {
    const step = byId.get(eventId);
    const [app, ...detail] = (step?.label ?? eventId).split(" — ");
    return { id: eventId, app, detail: detail.join(" — ") || eventId };
  };
  const work = trace?.workEvidenceIds.map(node) ?? [];
  const detours = trace?.detourEvidenceIds.map(node) ?? [];
  const proofLabel = (kind: NonNullable<RecallState["workTrace"]>["proof"][number]["kind"]) => ({
    "same-artifact": "동일 자원 확인",
    "exact-return": "같은 문서 복귀",
    "new-window": "새 창 생성",
    time: "전환 시각 확인",
    "shared-anchor": "공통 단서 확인",
  })[kind];

  return (
    <main className="trace-lab-shell">
      <header className="trace-lab-topbar">
        <div className="wordmark"><Mark compact /><span>here</span></div>
        <span>Work Trace Lab</span>
      </header>
      {!trace ? (
        <section className="trace-lab-empty">
          <LoaderCircle className="spinner" size={20} />
          <p>추적 결과를 준비하고 있습니다.</p>
        </section>
      ) : (
        <section className="trace-lab-content">
          <header className="trace-lab-heading">
            <div>
              <span className="trace-id">{trace.traceId}</span>
              <span className={`trace-confidence is-${trace.confidence}`}>{trace.confidence}</span>
            </div>
            <h1>현재 Excel에 영향을 준 기록 {work.length}개를 찾았습니다.</h1>
            <p>현재 창에서 원인을 거슬러 올라가 관련 기록만 선택했습니다.</p>
          </header>

          <div className="trace-lab-grid">
            <section className="trace-graph" aria-label="현재 업무의 원인 추적 결과">
              <div className="trace-graph-caption">
                <b>역방향 원인 추적</b>
                <span>{trace.excludedEventCount}개 창 제외</span>
              </div>
              <ol className="trace-main-path">
                {work.map((item, index) => (
                  <li key={item.id} className={item.id === trace.currentEvidenceId ? "is-current" : ""}>
                    <span className="trace-node-index">{index + 1}</span>
                    <div><b>{item.app}</b><p>{item.detail}</p></div>
                    {index < work.length - 1 && <ArrowRight size={17} aria-hidden="true" />}
                  </li>
                ))}
              </ol>
              {detours.length > 0 && (
                <div className="trace-detours">
                  <span>중간에 확인한 창</span>
                  {detours.map((item) => (
                    <div key={item.id}><WindowIcon app={item.app} /><b>{item.app}</b><p>{item.detail}</p></div>
                  ))}
                </div>
              )}
            </section>

            <aside className="trace-proof" aria-label="업무 연결 근거">
              <h2>연결을 확정한 근거</h2>
              <ul>
                {trace.proof
                  .filter(({ strength }) => strength === "exact" || strength === "strong")
                  .map((item, index) => (
                    <li key={`${item.kind}-${index}`}>
                      <Check size={16} aria-hidden="true" />
                      <div><b>{proofLabel(item.kind)}</b><p>{item.detail}</p></div>
                    </li>
                  ))}
              </ul>
              <div className="trace-model-input">
                <span>사내 AI에 전달</span>
                <strong>{[...trace.workEvidenceIds, ...trace.detourEvidenceIds].length}개 근거 ID</strong>
                <code>{[...trace.workEvidenceIds, ...trace.detourEvidenceIds].join(" · ")}</code>
              </div>
            </aside>
          </div>
        </section>
      )}
    </main>
  );
}

function Toggle({ checked, onChange, label, detail }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail?: string }) {
  return (
    <label className="toggle-row">
      <span><b>{label}</b>{detail && <small>{detail}</small>}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function ProviderChoice({ value, active, icon, label, detail, onClick }: { value: ModelProvider; active: boolean; icon: React.ReactNode; label: string; detail: string; onClick: (value: ModelProvider) => void }) {
  return (
    <button className={`provider-choice ${active ? "is-active" : ""}`} onClick={() => onClick(value)}>
      {icon}<span><b>{label}</b><small>{detail}</small></span>{active && <Check size={14} />}
    </button>
  );
}

function SettingsPanel() {
  const [settings, setSettings] = useState<PublicSettings>();
  const [desktop, setDesktop] = useState<DesktopBootstrap>();
  const [key, setKey] = useState("");
  const [exclude, setExclude] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    void api.bootstrap().then((value) => {
      setDesktop(value);
      setSettings(value.settings);
      setExclude(value.settings.excludedApps.join(", "));
    });
    return api.onSettings((value) => {
      setSettings(value);
      setExclude(value.excludedApps.join(", "));
    });
  }, []);

  const update = <K extends keyof PublicSettings>(field: K, value: PublicSettings[K]) => {
    setNotice(undefined);
    setSettings((current) => (current ? { ...current, [field]: value } : current));
  };

  const chooseProvider = (provider: ModelProvider) => {
    setNotice(undefined);
    setSettings((current) => {
      if (!current) return current;
      return {
        ...current,
        modelProvider: provider,
        model:
          provider === "vertex-gcloud"
            ? current.model.startsWith("gemini-")
              ? current.model
              : "gemini-3.5-flash"
            : current.model.startsWith("gemini-")
              ? ""
              : current.model,
      };
    });
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setNotice(undefined);
    try {
      const next = await api.saveSettings({
        settings: {
          modelProvider: settings.modelProvider,
          endpoint: settings.endpoint,
          model: settings.model,
          vertexProject: settings.vertexProject,
          vertexLocation: settings.vertexLocation,
          includeWindowImage: settings.includeWindowImage,
          captureConsent: settings.captureConsent,
          shortcut: settings.shortcut,
          checkpointShortcut: settings.checkpointShortcut,
          retentionMinutes: settings.retentionMinutes,
          excludedApps: exclude.split(",").map((item) => item.trim()).filter(Boolean),
          showBubble: settings.showBubble,
          autoStart: settings.autoStart,
        },
        apiKey: key || undefined,
      });
      setSettings(next);
      setKey("");
      setNotice("저장했어요");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "저장하지 못했어요");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!settings) return;
    setTesting(true);
    setNotice(settings.modelProvider === "vertex-gcloud" ? "Vertex 연결 확인 중…" : "사내 AI 연결 확인 중…");
    try {
      const result = await api.testConnection({
        modelProvider: settings.modelProvider,
        endpoint: settings.endpoint,
        model: settings.model,
        vertexProject: settings.vertexProject,
        vertexLocation: settings.vertexLocation,
        apiKey: key || undefined,
        testVision: !isVertex && settings.includeWindowImage,
      });
      if (result.ok && result.reconstructionVerified) {
        const mode =
          result.structuredOutputMode === "json-schema"
            ? "JSON Schema"
            : result.structuredOutputMode === "json-object"
              ? "JSON object"
              : result.structuredOutputMode === "prompt-only"
                ? "prompt JSON"
                : undefined;
        const vision = result.visionRequested
          ? result.visionVerified
            ? "이미지 입력 확인"
            : "이미지는 제외하고 연결됨"
          : undefined;
        setNotice(
          [
            "연결 완료",
            mode ? "응답 형식 확인" : undefined,
            vision,
            result.latencyMs !== undefined ? `${result.latencyMs}ms` : undefined,
            "저장을 눌러 적용",
          ]
            .filter(Boolean)
            .join(" · "),
        );
      } else
        setNotice(result.error || "Here에서 사용할 수 있는 응답인지 확인하지 못했어요");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "연결하지 못했어요");
    } finally {
      setTesting(false);
    }
  };

  const removeKey = async () => {
    const next = await api.saveSettings({ settings: {}, clearApiKey: true });
    setSettings(next);
    setKey("");
    setNotice("저장된 키를 지웠어요");
  };

  const clearContext = async () => {
    await api.clearHistory();
    await api.clearCheckpoints();
    setNotice("최근 창 기록과 저장한 작업을 모두 지웠어요");
  };

  if (!settings)
    return <main className="settings-shell"><div className="settings-loading"><LoaderCircle className="spinner" /></div></main>;

  const isVertex = settings.modelProvider === "vertex-gcloud";
  const privacyShowcase = showcase && query.get("settingsView") === "privacy";
  return (
    <main className={`settings-shell ${privacyShowcase ? "showcase-privacy" : ""}`}>
      <header className="settings-header">
        <div className="settings-title"><div className="wordmark"><Mark compact /><span>here</span></div><b>설정</b></div>
        <button className="icon-button" onClick={() => void api.closeSettings()} aria-label="닫기"><X size={18} /></button>
      </header>

      <div className="settings-scroll">
        <section className="setting-section recording-section">
          <div className="section-title"><span>최근 작업</span><small>내 PC에만 저장</small></div>
          <div className="settings-card">
            <Toggle checked={settings.captureConsent} onChange={(value) => update("captureConsent", value)} label="최근 사용한 창 기록" detail={`최근 ${settings.retentionMinutes}분 · 앱과 창 제목`} />
            <Toggle checked={settings.includeWindowImage} onChange={(value) => update("includeWindowImage", value)} label="현재 창 이미지 사용" detail="하던 일 찾기·작업 저장을 누를 때만 1장" />
          </div>
        </section>

        <section className="setting-section model-section">
          <div className="section-title"><span>AI 연결</span><small>OpenAI API 호환</small></div>
          <div className="provider-grid">
            <ProviderChoice value="openai-compatible" active={!isVertex} icon={<Server size={16} />} label="사내 AI" detail="vLLM · OpenAI API 호환" onClick={chooseProvider} />
            <ProviderChoice value="vertex-gcloud" active={isVertex} icon={<Cloud size={16} />} label="Vertex 테스트" detail="Mac 개발용" onClick={chooseProvider} />
          </div>

          {isVertex ? (
            <div className="provider-fields" key="vertex-fields">
              <label className="field"><span>Google Cloud 프로젝트 <em>gcloud</em></span><input aria-label="Google Cloud 프로젝트" value={settings.vertexProject} onChange={(event) => update("vertexProject", event.target.value)} placeholder="현재 프로젝트 사용" /></label>
              <div className="field-pair">
                <label className="field"><span>리전</span><input aria-label="Vertex 리전" value={settings.vertexLocation} onChange={(event) => update("vertexLocation", event.target.value)} placeholder="global" /></label>
                <label className="field"><span>모델 이름</span><input aria-label="Vertex 모델 이름" value={settings.model} onChange={(event) => update("model", event.target.value)} placeholder="gemini-3.5-flash" /></label>
              </div>
            </div>
          ) : (
            <div className="provider-fields" key="openai-fields">
              <label className="field"><span>API 주소 <em>/v1</em></span><input aria-label="OpenAI API 호환 주소" value={settings.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="https://llm.company.internal/v1" /></label>
              <label className="field"><span>모델 이름</span><input aria-label="OpenAI API 호환 모델 이름" value={settings.model} onChange={(event) => update("model", event.target.value)} placeholder="Qwen/Qwen2.5-72B-Instruct" /></label>
              <label className="field"><span>접근 토큰 <em>{settings.apiKeyConfigured ? "저장됨" : "선택"}</em></span><div className="key-input"><input aria-label="접근 토큰" type={showKey ? "text" : "password"} value={key} onChange={(event) => { setNotice(undefined); setKey(event.target.value); }} placeholder={settings.apiKeyConfigured ? "새 토큰으로 교체" : "인증이 없으면 비워두기"} autoComplete="new-password" spellCheck={false} /><button onClick={() => setShowKey(!showKey)} aria-label={showKey ? "토큰 숨기기" : "토큰 보기"}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
            </div>
          )}
          <div className="inline-actions">
            <button className="test-button" disabled={testing} onClick={() => void test()}>{testing ? <LoaderCircle className="spinner" size={14} /> : <Zap size={14} />} {isVertex ? "Vertex 연결 확인" : settings.includeWindowImage ? "이미지 포함 연결 확인" : "연결 확인"}</button>
            {!isVertex && settings.apiKeyConfigured && <button className="test-button muted-action" onClick={() => void removeKey()}>저장된 토큰 삭제</button>}
          </div>
        </section>

        <section className="setting-section shortcut-section">
          <div className="section-title"><span>단축키</span><small>다른 앱에서도 사용</small></div>
          <div className="settings-card shortcut-list">
            <div className="shortcut-card"><span><Clock3 size={15} /><b>하던 일 찾기</b></span><kbd>{desktop?.platform === "darwin" ? "⌘ ⇧ Space" : "Ctrl ⇧ Space"}</kbd>{desktop && !desktop.shortcutRegistered && <em>사용 중</em>}</div>
            <div className="shortcut-card"><span><Bookmark size={15} /><b>작업 저장</b></span><kbd>{desktop?.platform === "darwin" ? "⌘ ⇧ M" : "Ctrl ⇧ M"}</kbd>{desktop && !desktop.checkpointShortcutRegistered && <em>사용 중</em>}</div>
          </div>
        </section>

        <section className="setting-section compact-settings">
          <div className="section-title"><span>실행 설정</span><small>Here 동작</small></div>
          <div className="field-pair">
            <label className="field"><span>최근 창 기록 보관</span><select value={settings.retentionMinutes} onChange={(event) => update("retentionMinutes", Number(event.target.value))}><option value={5}>5분</option><option value={10}>10분</option><option value={15}>15분</option><option value={30}>30분</option></select></label>
            <label className="field"><span>기록하지 않을 앱</span><input value={exclude} onChange={(event) => setExclude(event.target.value)} placeholder="1Password, Bitwarden" /></label>
          </div>
          <div className="settings-card app-toggles">
            <Toggle checked={settings.showBubble} onChange={(value) => update("showBubble", value)} label="작은 버튼 표시" />
            <Toggle checked={settings.autoStart} onChange={(value) => update("autoStart", value)} label="로그인할 때 자동 시작" />
          </div>
          <button className="danger-button" onClick={() => void clearContext()}><Trash2 size={14} /> 최근 창 기록과 저장한 작업 모두 삭제</button>
        </section>
      </div>

      <footer className="settings-footer"><span aria-live="polite">{notice}</span><button className="save-button" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spinner" size={15} /> : <Check size={16} />} 저장</button></footer>
    </main>
  );
}

export default function App() {
  const surface = useMemo(getSurface, []);
  if (demo) return <DemoWorkspace />;
  if (surface === "bubble") return <Bubble />;
  if (surface === "settings") return <SettingsPanel />;
  if (surface === "trace") return <TraceLab />;
  return <RecallPanel />;
}
