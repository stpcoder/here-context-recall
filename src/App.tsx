import { AnimatePresence, motion } from "framer-motion";
import {
  AppWindow,
  ArrowRight,
  Bookmark,
  Camera,
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
  Pause,
  Play,
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
  interruptionSummary,
  type JourneyMoment,
} from "./context-journey";
import { createShowcaseApi } from "./showcase-api";

type Surface = "bubble" | "recall" | "settings";

const query = new URLSearchParams(window.location.search);
const showcase = import.meta.env.DEV && query.get("showcase") === "1";
if (showcase && query.get("captureScale")) {
  const scale = Math.max(1, Math.min(3, Number(query.get("captureScale")) || 1));
  const isBubbleCapture = query.get("surface") === "bubble";
  const width = Math.max(isBubbleCapture ? 1 : 320, Number(query.get("captureWidth")) || 900);
  const height = Math.max(isBubbleCapture ? 1 : 320, Number(query.get("captureHeight")) || 620);
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
  return value === "bubble" || value === "settings" ? value : "recall";
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
      ? "기억하는 중"
      : flash
        ? "여기 기억했어요"
        : "Why am I here?";

  return (
    <motion.button
      className={`bubble ${expanded || flash ? "is-expanded" : ""} ${flash ? "is-saved" : ""}`}
      aria-label="Why am I here? 최근 업무 흐름 보기"
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
      {stats?.paused && <span className="bubble-paused">paused</span>}
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
      <div className="journey-rail"><span><WindowIcon app={item.app} /></span></div>
      <div className="journey-content">
        <div className="journey-meta">
          <span>{item.phaseLabel}</span>
          <time>{clock(item.timestamp)}</time>
        </div>
        <div className="journey-window">
          <strong>{item.app}</strong>
          <p title={item.detail}>{item.detail}</p>
        </div>
      </div>
    </motion.li>
  );
}

function JourneyTimeline({ state }: { state: RecallState }) {
  const journey = buildContextJourney(state);
  const first = journey[0];
  const last = journey.at(-1);
  return (
    <section className="journey-card" aria-label="현재 창에 오기까지의 시간순 흐름">
      <header className="journey-header">
        <div><span>이 창까지의 흐름</span><small>위에서 아래로 읽으세요</small></div>
        {first && last && <time>{clock(first.timestamp)}—{clock(last.timestamp)}</time>}
      </header>
      <ol className="journey-list">
        {journey.map((item, index) => <JourneyRow key={item.eventId} item={item} index={index} />)}
      </ol>
    </section>
  );
}

function ContinueCard({ state, onResume }: { state: RecallState; onResume: () => void }) {
  const currentTitle = titleLabel(state.current) || "현재 창";
  const target = state.reconstruction?.target?.trim();
  const showTarget = Boolean(target && target.toLocaleLowerCase() !== currentTitle.toLocaleLowerCase());
  const nextAction = state.reconstruction?.nextAction || state.explanation?.nextAction || "현재 창에서 계속 확인하기";
  const image = state.contextImage;
  return (
    <section className="continue-card" aria-label="현재 창과 이어서 할 일">
      <header className="continue-header">
        <span>지금 화면</span>
        <small>{image ? <><Camera size={12} />복원 순간 1장</> : "화면 미리보기 꺼짐"}</small>
      </header>
      <div className={`window-preview ${image ? "has-image" : ""}`}>
        {image ? (
          <img src={image.dataUrl} alt="사용자가 복원 순간에 허용한 현재 창 미리보기" />
        ) : (
          <div className="window-placeholder"><WindowIcon app={appLabel(state.current)} /><i /><i /><i /></div>
        )}
        <div className="window-caption">
          <span>{appLabel(state.current)}</span>
          <strong title={currentTitle}>{currentTitle}</strong>
        </div>
      </div>
      <div className="continue-details">
        {showTarget && <div><span>찾으려던 지점</span><strong>{target}</strong></div>}
        <div><span>이어서 할 일</span><strong>{nextAction}</strong></div>
      </div>
      <button className="primary-action continue-action" onClick={onResume}>
        Here 닫고 이 창 계속 <ArrowRight size={17} />
      </button>
    </section>
  );
}

function EmptyState({ onRemember, onSettings }: { onRemember: () => void; onSettings: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-orbit"><Mark /></div>
      <h1>여기부터 기억할까요?</h1>
      <p className="muted">다음에 바로 돌아올 수 있어요.</p>
      <div className="empty-actions">
        <button className="primary-action" onClick={onRemember}>
          <Bookmark size={16} /> 여기 기억하기
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
  const [stats, setStats] = useState<DesktopBootstrap["stats"]>();
  const [settings, setSettings] = useState<PublicSettings>();
  const [checkpoint, setCheckpoint] = useState<CheckpointState>();
  const refresh = useCallback(async () => {
    const boot = await api.bootstrap();
    setState(boot.recall);
    setStats(boot.stats);
    setSettings(boot.settings);
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
  const pause = async () => {
    const next = stats?.paused
      ? await api.resumeCapture()
      : await api.pauseCapture();
    setStats(next);
  };
  const remember = async () => setCheckpoint(await api.remember());
  const heading = state?.reconstruction?.summary || state?.explanation?.answer;
  const hasContext = Boolean(
    state?.current || state?.explanation?.chain.length || state?.checkpoint,
  );
  const modelLabel =
    state?.reconstruction?.source === "model"
      ? settings?.modelProvider === "vertex-gcloud" ? "QA 복원" : "AI 복원"
      : "로컬 복원";
  const saved = state?.checkpoint ?? checkpoint?.latest;
  const evidenceCount = state?.explanation?.evidenceIds.length ?? 0;
  const currentTitle = titleLabel(state?.current) || "현재 창";
  const returnDetail = state ? interruptionSummary(state) : undefined;

  return (
    <main className="recall-shell">
      <header className="panel-topbar">
        <div className="wordmark"><Mark compact /><span>here</span></div>
        <div className="topbar-actions">
          <span className={`mode-chip mode-${state?.mode ?? "recent"}`}>
            {state?.mode === "checkpoint" ? "저장한 지점" : "최근 10분"}
          </span>
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
            <p>흐름을 다시 잇는 중</p>
          </motion.section>
        ) : !hasContext ? (
          <motion.section key="empty" initial={showcase ? false : { opacity: 0 }} animate={{ opacity: 1 }}>
            <EmptyState onRemember={() => void remember()} onSettings={() => void api.openSettings()} />
          </motion.section>
        ) : (
          <motion.section key={`${state?.mode}-${state?.updatedAt}`} className="recall-layout" initial={showcase ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <header className="recall-intro">
              <div className="result-label">
                <i /> {state?.mode === "checkpoint" ? "저장한 작업" : state?.explanation?.interrupted ? "이 창으로 돌아옴" : "현재 창"}
                <span>·</span>
                {state?.mode === "checkpoint" ? moment(state.checkpoint?.createdAt) : "방금"}
                {returnDetail && <><span>·</span>{returnDetail}</>}
              </div>
              <h1 title={currentTitle}>{currentTitle}</h1>
              <div className="recall-reason"><span>이 창을 연 이유</span><p>{heading || "이 창을 열기 전 흐름을 확인하세요."}</p></div>
            </header>
            <div className="recall-body">
              <JourneyTimeline state={state!} />
              <aside className="recall-aside">
                <ContinueCard state={state!} onResume={dismiss} />
              {saved && state?.mode !== "checkpoint" && (
                <button className="saved-context" onClick={() => void api.recall("saved")}>
                  <Bookmark size={14} />
                  <span><small>이전 저장 지점 · {moment(saved.createdAt)}</small><strong>{titleLabel(saved.event)}</strong></span>
                  <ChevronRight size={15} />
                </button>
              )}
              </aside>
            </div>
            {state?.message && <p className="error-note">{state.message}</p>}
            <footer className="recall-footer">
              <div className="grounding-note"><i /><b>{modelLabel}</b><span>관측한 창 {evidenceCount || 1}개로 구성</span></div>
              <button className="memory-action" onClick={() => void remember()} disabled={checkpoint?.status === "saving"}>
                {checkpoint?.status === "saving" ? <LoaderCircle className="spinner" size={15} /> : <Bookmark size={15} />}
                {checkpoint?.status === "saving" ? "기억하는 중" : "이 지점 기억"}
                <kbd>{navigator.platform.includes("Mac") ? "⌘⇧M" : "Ctrl⇧M"}</kbd>
              </button>
              <button className="pause-action" onClick={() => void pause()} aria-label={stats?.paused ? "기록 다시 시작" : "기록 일시 정지"}>
                {stats?.paused ? <Play size={15} /> : <Pause size={15} />}
              </button>
            </footer>
            {checkpoint?.message && <div className={`checkpoint-note is-${checkpoint.status}`}>{checkpoint.message}</div>}
          </motion.section>
        )}
      </AnimatePresence>
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
    setNotice(settings.modelProvider === "vertex-gcloud" ? "로컬 QA 모델 호출 중…" : "선택한 업무 모델 호출 중…");
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
            ? "VLM 이미지 확인"
            : "text-only 자동 전환"
          : undefined;
        setNotice(
          [
            "연결됨",
            mode,
            vision,
            result.latencyMs !== undefined ? `${result.latencyMs}ms` : undefined,
            "저장 필요",
          ]
            .filter(Boolean)
            .join(" · "),
        );
      } else
        setNotice(result.error || "Here 복원 형식을 확인하지 못했어요");
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
    setNotice("최근 흐름과 저장된 맥락을 지웠어요");
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
          <div className="section-title"><span>기록</span><small>기기 안에서만</small></div>
          <div className="settings-card">
            <Toggle checked={settings.captureConsent} onChange={(value) => update("captureConsent", value)} label="창 흐름 기록" detail={`최근 ${settings.retentionMinutes}분 · 앱과 창 제목`} />
            <Toggle checked={settings.includeWindowImage} onChange={(value) => update("includeWindowImage", value)} label="현재 창 미리보기" detail="복원·기억을 누른 순간에만 1장" />
          </div>
        </section>

        <section className="setting-section model-section">
          <div className="section-title"><span>모델</span><small>OpenAI-compatible</small></div>
          <div className="provider-grid">
            <ProviderChoice value="openai-compatible" active={!isVertex} icon={<Server size={16} />} label="Work AI" detail="사내 vLLM" onClick={chooseProvider} />
            <ProviderChoice value="vertex-gcloud" active={isVertex} icon={<Cloud size={16} />} label="Vertex QA" detail="Mac QA" onClick={chooseProvider} />
          </div>

          {isVertex ? (
            <div className="provider-fields" key="vertex-fields">
              <label className="field"><span>Google Cloud project <em>gcloud</em></span><input aria-label="Google Cloud project" value={settings.vertexProject} onChange={(event) => update("vertexProject", event.target.value)} placeholder="현재 project 사용" /></label>
              <div className="field-pair">
                <label className="field"><span>Location</span><input aria-label="Vertex location" value={settings.vertexLocation} onChange={(event) => update("vertexLocation", event.target.value)} placeholder="global" /></label>
                <label className="field"><span>Model</span><input aria-label="Vertex model" value={settings.model} onChange={(event) => update("model", event.target.value)} placeholder="gemini-3.5-flash" /></label>
              </div>
            </div>
          ) : (
            <div className="provider-fields" key="openai-fields">
              <label className="field"><span>Base URL <em>/v1</em></span><input aria-label="OpenAI-compatible Base URL" value={settings.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="https://llm.company.internal/v1" /></label>
              <label className="field"><span>Model ID</span><input aria-label="OpenAI-compatible Model ID" value={settings.model} onChange={(event) => update("model", event.target.value)} placeholder="Qwen/Qwen2.5-72B-Instruct" /></label>
              <label className="field"><span>Bearer token <em>{settings.apiKeyConfigured ? "저장됨" : "선택"}</em></span><div className="key-input"><input aria-label="Bearer token" type={showKey ? "text" : "password"} value={key} onChange={(event) => { setNotice(undefined); setKey(event.target.value); }} placeholder={settings.apiKeyConfigured ? "새 token으로 교체" : "로컬 무인증은 비워두기"} autoComplete="new-password" spellCheck={false} /><button onClick={() => setShowKey(!showKey)} aria-label={showKey ? "token 숨기기" : "token 보기"}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
            </div>
          )}
          <div className="inline-actions">
            <button className="test-button" disabled={testing} onClick={() => void test()}>{testing ? <LoaderCircle className="spinner" size={14} /> : <Zap size={14} />} {isVertex ? "QA 테스트" : settings.includeWindowImage ? "VLM 연결 테스트" : "연결 테스트"}</button>
            {!isVertex && settings.apiKeyConfigured && <button className="test-button muted-action" onClick={() => void removeKey()}>token 지우기</button>}
          </div>
        </section>

        <section className="setting-section shortcut-section">
          <div className="section-title"><span>단축키</span><small>전역</small></div>
          <div className="settings-card shortcut-list">
            <div className="shortcut-card"><span><Clock3 size={15} /><b>복원</b></span><kbd>{desktop?.platform === "darwin" ? "⌘ ⇧ Space" : "Ctrl ⇧ Space"}</kbd>{desktop && !desktop.shortcutRegistered && <em>충돌</em>}</div>
            <div className="shortcut-card"><span><Bookmark size={15} /><b>기억</b></span><kbd>{desktop?.platform === "darwin" ? "⌘ ⇧ M" : "Ctrl ⇧ M"}</kbd>{desktop && !desktop.checkpointShortcutRegistered && <em>충돌</em>}</div>
          </div>
        </section>

        <section className="setting-section compact-settings">
          <div className="section-title"><span>앱</span><small>백그라운드</small></div>
          <div className="field-pair">
            <label className="field"><span>보관 시간</span><select value={settings.retentionMinutes} onChange={(event) => update("retentionMinutes", Number(event.target.value))}><option value={5}>5분</option><option value={10}>10분</option><option value={15}>15분</option><option value={30}>30분</option></select></label>
            <label className="field"><span>제외 앱</span><input value={exclude} onChange={(event) => setExclude(event.target.value)} placeholder="1Password, Bitwarden" /></label>
          </div>
          <div className="settings-card app-toggles">
            <Toggle checked={settings.showBubble} onChange={(value) => update("showBubble", value)} label="화면 버튼" />
            <Toggle checked={settings.autoStart} onChange={(value) => update("autoStart", value)} label="로그인 시 시작" />
          </div>
          <button className="danger-button" onClick={() => void clearContext()}><Trash2 size={14} /> 로컬 기록 모두 삭제</button>
        </section>
      </div>

      <footer className="settings-footer"><span aria-live="polite">{notice}</span><button className="save-button" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spinner" size={15} /> : <Check size={16} />} 저장</button></footer>
    </main>
  );
}

export default function App() {
  const surface = useMemo(getSurface, []);
  if (surface === "bubble") return <Bubble />;
  if (surface === "settings") return <SettingsPanel />;
  return <RecallPanel />;
}
