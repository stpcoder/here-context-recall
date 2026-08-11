import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Bookmark,
  Camera,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  Eye,
  EyeOff,
  LoaderCircle,
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
import { createShowcaseApi } from "./showcase-api";

type Surface = "bubble" | "recall" | "settings";

const query = new URLSearchParams(window.location.search);
const showcase = import.meta.env.DEV && query.get("showcase") === "1";
if (showcase && query.get("captureScale")) {
  const scale = Math.max(1, Math.min(3, Number(query.get("captureScale")) || 1));
  const isBubbleCapture = query.get("surface") === "bubble";
  const width = Math.max(isBubbleCapture ? 1 : 320, Number(query.get("captureWidth")) || 820);
  const height = Math.max(isBubbleCapture ? 1 : 320, Number(query.get("captureHeight")) || 700);
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

function splitEvidenceLabel(value?: string): { app: string; detail: string } {
  if (!value) return { app: "최근 활동", detail: "시작점이 아직 충분하지 않아요." };
  const [app, ...detail] = value.split(" — ");
  return { app, detail: detail.join(" — ") || value };
}

function interruptionLabel(state: RecallState): string | undefined {
  const chain = state.explanation?.chain ?? [];
  const interruption = chain.find((step) => step.role === "interruption");
  const current = chain.at(-1);
  if (!interruption || !current) return undefined;
  const minutes = Math.max(1, Math.round((current.timestamp - interruption.timestamp) / 60_000));
  return `${splitEvidenceLabel(interruption.label).app} · ${minutes}분 멈춤`;
}

function OriginCard({ state }: { state: RecallState }) {
  const chain = state.explanation?.chain ?? [];
  const start = chain.find((step) => step.role === "context") ?? chain[0];
  const origin = splitEvidenceLabel(state.explanation?.origin || start?.label);
  return (
    <section className="origin-card" aria-label="업무가 시작된 이유">
      <header>
        <span>시작점</span>
        <time>{origin.app}{start ? ` · ${clock(start.timestamp)}` : ""}</time>
      </header>
      <p>{origin.detail}</p>
    </section>
  );
}

function EvidenceTrail({ state }: { state: RecallState }) {
  const chain = state.explanation?.chain ?? [];
  const path = chain
    .filter((step) => step.role === "context" || step.role === "target")
    .slice(0, 3);
  if (!path.length && state.current)
    path.push({
      eventId: state.current.id,
      timestamp: state.current.timestamp,
      label: `${appLabel(state.current)} — ${titleLabel(state.current)}`,
      role: "target",
    });
  return (
    <section className="evidence-trail" aria-label="관찰한 실제 이동 경로">
      <div className="trail-title">
        <span>실제 이동</span>
        <small>{chain.length || path.length}개 창 근거</small>
      </div>
      <div className="trail-row">
        {path.map((step, index) => (
          <motion.div
            className="trail-step"
            key={step.eventId}
            initial={showcase ? false : { opacity: 0, x: -5 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.05, duration: 0.18 }}
          >
            {index > 0 && <ArrowRight size={12} aria-hidden="true" />}
            <b>{splitEvidenceLabel(step.label).app}</b>
            <time>{clock(step.timestamp)}</time>
          </motion.div>
        ))}
      </div>
      {interruptionLabel(state) && <div className="interruption-note"><i />{interruptionLabel(state)}</div>}
    </section>
  );
}

function ResumeCard({ state, onResume }: { state: RecallState; onResume: () => void }) {
  const target = state.reconstruction?.target || titleLabel(state.current) || "현재 작업";
  const nextAction = state.reconstruction?.nextAction || state.explanation?.nextAction || "현재 창에서 이어서 확인하기";
  const image = state.contextImage;
  return (
    <section className="resume-card" aria-label="다시 시작할 지점">
      <div className="resume-kicker">
        <span><i />다시 시작할 곳</span>
        {image && <small><Camera size={11} />1회 보기</small>}
      </div>
      <h2 title={target}>{target}</h2>
      <div className={`artifact-card ${image ? "has-image" : ""}`}>
        {image && <img src={image.dataUrl} alt="사용자가 복원 순간에 허용한 창 미리보기" />}
        <div>
          <span>{state.mode === "checkpoint" ? "저장한 창" : "현재 창"}</span>
          <b>{appLabel(state.current)}</b>
          <small>{titleLabel(state.current)}</small>
        </div>
      </div>
      <div className="next-step">
        <span>다음 한 단계</span>
        <p>{nextAction}</p>
      </div>
      <button className="primary-action resume-action" onClick={onResume}>
        이 지점에서 계속 <ArrowRight size={17} />
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

  return (
    <main className="recall-shell">
      <header className="panel-topbar">
        <div className="wordmark"><Mark compact /><span>here</span></div>
        <div className="topbar-actions">
          <span className={`mode-chip mode-${state?.mode ?? "recent"}`}>
            {state?.mode === "checkpoint" ? "저장됨" : "최근 흐름"}
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
            <div className="recall-copy">
              <div className="result-label">
                <i /> 맥락 복원
                <span>·</span>
                {state?.mode === "checkpoint" ? moment(state.checkpoint?.createdAt) : "방금"}
                {state?.explanation?.interrupted && <><span>·</span>방해 후 복귀</>}
              </div>
              <h1>{heading || "멈춘 작업을 되찾았어요."}</h1>
              <OriginCard state={state!} />
              <EvidenceTrail state={state!} />
            </div>
            <aside className="recall-aside">
              <ResumeCard state={state!} onResume={dismiss} />
              {saved && state?.mode !== "checkpoint" && (
                <button className="saved-context" onClick={() => void api.recall("saved")}>
                  <Bookmark size={14} />
                  <span><small>{moment(saved.createdAt)} 저장</small><strong>{titleLabel(saved.event)}</strong></span>
                  <ChevronRight size={15} />
                </button>
              )}
            </aside>
            {state?.message && <p className="error-note">{state.message}</p>}
            <footer className="recall-footer">
              <div className="grounding-note"><i /><b>{modelLabel}</b><span>실제 창 {evidenceCount || 1}개만 근거로 사용</span></div>
              <button className="memory-action" onClick={() => void remember()} disabled={checkpoint?.status === "saving"}>
                {checkpoint?.status === "saving" ? <LoaderCircle className="spinner" size={15} /> : <Bookmark size={15} />}
                {checkpoint?.status === "saving" ? "기억하는 중" : "여기 기억"}
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
            <Toggle checked={settings.includeWindowImage} onChange={(value) => update("includeWindowImage", value)} label="화면 컨텍스트" detail="직접 복원할 때만 1장" />
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
