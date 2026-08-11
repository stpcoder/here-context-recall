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
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ActivityEvent,
  CheckpointState,
  DesktopBootstrap,
  ModelProvider,
  PublicSettings,
  RecallState,
} from "../electron/shared/contracts";

type Surface = "bubble" | "recall" | "settings";

const api = window.here;

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
  const [expanded, setExpanded] = useState(false);
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
      initial={{ opacity: 0, scale: 0.86 }}
      animate={{ opacity: 1, scale: 1 }}
    >
      <Mark compact />
      <span className="bubble-copy">{label}</span>
      {stats?.paused && <span className="bubble-paused">paused</span>}
    </motion.button>
  );
}

function EvidenceChain({ state }: { state: RecallState }) {
  const chain = state.explanation?.chain ?? [];
  if (!chain.length && state.current)
    return (
      <div className="single-evidence">
        <span />
        <time>{clock(state.current.timestamp)}</time>
        <div>
          <strong>{appLabel(state.current)}</strong>
          <small>{titleLabel(state.current)}</small>
        </div>
      </div>
    );
  return (
    <ol className="chain" aria-label="관찰한 업무 흐름">
      {chain.slice(-5).map((step, index) => (
        <motion.li
          key={step.eventId}
          className={`chain-item chain-${step.role}`}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.12 + index * 0.065, duration: 0.3 }}
        >
          <span className="chain-rail"><i /></span>
          <time>{clock(step.timestamp)}</time>
          <div>
            <strong>{step.label}</strong>
            <small>
              {step.role === "interruption"
                ? "잠깐 끊김"
                : step.role === "return"
                  ? "다시 돌아옴"
                  : "창 전환"}
            </small>
          </div>
        </motion.li>
      ))}
    </ol>
  );
}

function ContextVisual({ state }: { state: RecallState }) {
  const image = state.contextImage;
  return (
    <div className={`context-visual ${image ? "has-image" : "is-abstract"}`}>
      {image ? (
        <img src={image.dataUrl} alt="사용자가 복원 순간에 허용한 창 미리보기" />
      ) : (
        <div className="memory-orbit" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      )}
      <div className="visual-shade" />
      <div className="visual-caption">
        <span>{state.mode === "checkpoint" ? "SAVED CONTEXT" : "CURRENT WINDOW"}</span>
        <strong>{appLabel(state.current)}</strong>
        <small>{titleLabel(state.current)}</small>
      </div>
      {image && (
        <div className="vision-chip">
          <Camera size={11} />
          {state.mode === "checkpoint"
            ? "암호화해 저장한 화면"
            : "이번 복원에만 본 화면"}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onRemember, onSettings }: { onRemember: () => void; onSettings: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-orbit"><Mark /></div>
      <p className="eyebrow">FIRST MEMORY</p>
      <h1>여기부터<br />기억해둘까요?</h1>
      <p className="muted">한 번 저장하면 내일도 이 지점으로 돌아옵니다.</p>
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
  const nextAction =
    state?.reconstruction?.nextAction || state?.explanation?.nextAction;
  const hasContext = Boolean(
    state?.current || state?.explanation?.chain.length || state?.checkpoint,
  );
  const modelLabel =
    state?.reconstruction?.source === "model"
      ? settings?.modelProvider === "vertex-gcloud"
        ? "Gemini 3.5 Flash"
        : "연결한 모델"
      : "로컬 근거";
  const saved = state?.checkpoint ?? checkpoint?.latest;

  return (
    <main className="recall-shell">
      <header className="panel-topbar">
        <div className="wordmark"><Mark compact /> here<span>.</span></div>
        <div className="topbar-actions">
          <span className={`mode-chip mode-${state?.mode ?? "recent"}`}>
            {state?.mode === "checkpoint" ? "저장된 맥락" : "지금 흐름"}
          </span>
          <button className="icon-button" onClick={() => void api.openSettings()} aria-label="설정 열기">
            <Settings2 size={17} />
          </button>
          <button className="icon-button" onClick={dismiss} aria-label="닫기"><X size={18} /></button>
        </div>
      </header>

      <AnimatePresence mode="wait">
        {state?.status === "loading" ? (
          <motion.section key="loading" className="recall-loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <LoaderCircle className="spinner" size={20} />
            <p>흐름을 다시 잇는 중</p>
          </motion.section>
        ) : !hasContext ? (
          <motion.section key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <EmptyState onRemember={() => void remember()} onSettings={() => void api.openSettings()} />
          </motion.section>
        ) : (
          <motion.section key={`${state?.mode}-${state?.updatedAt}`} className="recall-layout" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <div className="recall-copy">
              <div className="result-label">
                <Sparkles size={12} /> {modelLabel}
                <span>·</span>
                {state?.mode === "checkpoint" ? moment(state.checkpoint?.createdAt) : "방금"}
              </div>
              <h1>{heading || "이 창에서 하던 일을 이어가세요."}</h1>
              <div className="current-window">
                <span>{state?.mode === "checkpoint" ? "그때" : "현재"}</span>
                <b>{appLabel(state?.current)}</b>
                <em>{titleLabel(state?.current)}</em>
              </div>
              <EvidenceChain state={state!} />
            </div>
            <aside className="recall-aside">
              <ContextVisual state={state!} />
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
              <button className="primary-action" onClick={dismiss}>
                {nextAction || "여기서 계속하기"}<ArrowRight size={17} />
              </button>
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

  const update = <K extends keyof PublicSettings>(field: K, value: PublicSettings[K]) =>
    setSettings((current) => (current ? { ...current, [field]: value } : current));

  const chooseProvider = (provider: ModelProvider) =>
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
    setNotice(settings.modelProvider === "vertex-gcloud" ? "gcloud로 Vertex 확인 중…" : "연결 확인 중…");
    try {
      const result = await api.testConnection({
        modelProvider: settings.modelProvider,
        endpoint: settings.endpoint,
        model: settings.model,
        vertexProject: settings.vertexProject,
        vertexLocation: settings.vertexLocation,
        apiKey: key || undefined,
      });
      setNotice(result.ok ? `연결됨 · ${result.models[0] || "모델 확인"}` : result.error || "연결하지 못했어요");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "연결하지 못했어요");
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
  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div><div className="wordmark"><Mark compact /> here<span>.</span></div><p>기억할 순간만 남기고, 한 번에 돌아옵니다.</p></div>
        <button className="icon-button" onClick={() => void api.closeSettings()} aria-label="닫기"><X size={18} /></button>
      </header>

      <div className="settings-scroll">
        <section className="consent-card">
          <div className="consent-icon"><ShieldCheck size={18} /></div>
          <div className="consent-copy">
            <p className="eyebrow">PRIVATE BY DEFAULT</p>
            <h2>흐름은 짧게. 기억은 선택할 때만.</h2>
            <p>평소에는 앱·창 제목 전환만 메모리에 둡니다. 화면 한 장은 아래 옵션을 켜고 직접 기억하거나 복원할 때만 사용합니다.</p>
          </div>
          <Toggle checked={settings.captureConsent} onChange={(value) => update("captureConsent", value)} label="창 흐름 허용" detail={`최근 ${settings.retentionMinutes}분 · 종료하면 삭제`} />
          <Toggle checked={settings.includeWindowImage} onChange={(value) => update("includeWindowImage", value)} label="복원 순간의 창 한 장 보기" detail="VLM 분석과 암호화 체크포인트에만 사용" />
        </section>

        <section className="setting-section model-section">
          <div className="section-title"><span>AI 연결</span><small>선택 사항 · 실패해도 로컬 복원</small></div>
          <div className="provider-grid">
            <ProviderChoice value="vertex-gcloud" active={isVertex} icon={<Cloud size={17} />} label="Vertex AI" detail="gcloud · Gemini VLM" onClick={chooseProvider} />
            <ProviderChoice value="openai-compatible" active={!isVertex} icon={<Server size={17} />} label="OpenAI 호환" detail="vLLM · 사내 endpoint" onClick={chooseProvider} />
          </div>

          {isVertex ? (
            <div className="provider-fields" key="vertex-fields">
              <div className="vertex-banner"><Zap size={14} /><span><b>Gemini 3.5 Flash</b><small>이미지와 창 흐름을 함께 이해합니다.</small></span><em>gcloud</em></div>
              <label className="field"><span>Google Cloud project</span><input aria-label="Google Cloud project" value={settings.vertexProject} onChange={(event) => update("vertexProject", event.target.value)} placeholder="비워두면 gcloud 현재 project 사용" /></label>
              <div className="field-pair">
                <label className="field"><span>Location</span><input aria-label="Vertex location" value={settings.vertexLocation} onChange={(event) => update("vertexLocation", event.target.value)} placeholder="global" /></label>
                <label className="field"><span>Model</span><input aria-label="Vertex model" value={settings.model} onChange={(event) => update("model", event.target.value)} placeholder="gemini-3.5-flash" /></label>
              </div>
            </div>
          ) : (
            <div className="provider-fields" key="openai-fields">
              <label className="field"><span>Endpoint</span><input aria-label="OpenAI-compatible endpoint" value={settings.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="http://127.0.0.1:8000/v1" /></label>
              <label className="field"><span>Model</span><input aria-label="OpenAI-compatible model" value={settings.model} onChange={(event) => update("model", event.target.value)} placeholder="Qwen/Qwen2.5-7B-Instruct" /></label>
              <label className="field"><span>API key <em>{settings.apiKeyConfigured ? "저장됨" : "선택"}</em></span><div className="key-input"><input type={showKey ? "text" : "password"} value={key} onChange={(event) => setKey(event.target.value)} placeholder={settings.apiKeyConfigured ? "새 키를 입력하면 교체" : "OS 암호화 저장"} autoComplete="off" /><button onClick={() => setShowKey(!showKey)} aria-label={showKey ? "키 숨기기" : "키 보기"}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
            </div>
          )}
          <div className="inline-actions">
            <button className="test-button" onClick={() => void test()}><Zap size={13} /> 연결 확인</button>
            {!isVertex && settings.apiKeyConfigured && <button className="test-button muted-action" onClick={() => void removeKey()}>키 삭제</button>}
          </div>
        </section>

        <section className="setting-section">
          <div className="section-title"><span>한 번에 돌아오기</span><small>전역 단축키</small></div>
          <div className="shortcut-card"><span><Clock3 size={15} /><b>왜 여기지?</b></span><kbd>{desktop?.platform === "darwin" ? "⌘ ⇧ Space" : "Ctrl ⇧ Space"}</kbd>{desktop && !desktop.shortcutRegistered && <em>충돌</em>}</div>
          <div className="shortcut-card"><span><Bookmark size={15} /><b>여기 기억</b></span><kbd>{desktop?.platform === "darwin" ? "⌘ ⇧ M" : "Ctrl ⇧ M"}</kbd>{desktop && !desktop.checkpointShortcutRegistered && <em>충돌</em>}</div>
        </section>

        <section className="setting-section compact-settings">
          <div className="section-title"><span>백그라운드</span><small>언제든 변경</small></div>
          <div className="field-pair">
            <label className="field"><span>최근 흐름</span><select value={settings.retentionMinutes} onChange={(event) => update("retentionMinutes", Number(event.target.value))}><option value={5}>5분</option><option value={10}>10분</option><option value={15}>15분</option><option value={30}>30분</option></select></label>
            <label className="field"><span>제외할 앱</span><input value={exclude} onChange={(event) => setExclude(event.target.value)} placeholder="1Password, Bitwarden" /></label>
          </div>
          <Toggle checked={settings.showBubble} onChange={(value) => update("showBubble", value)} label="화면 버튼 표시" />
          <Toggle checked={settings.autoStart} onChange={(value) => update("autoStart", value)} label="로그인 시 시작" />
          <button className="danger-button" onClick={() => void clearContext()}><Trash2 size={14} /> 모든 로컬 맥락 지우기</button>
        </section>
      </div>

      <footer className="settings-footer"><span>{notice}</span><button className="save-button" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spinner" size={15} /> : <Check size={16} />} 저장</button></footer>
    </main>
  );
}

export default function App() {
  const surface = useMemo(getSurface, []);
  if (surface === "bubble") return <Bubble />;
  if (surface === "settings") return <SettingsPanel />;
  return <RecallPanel />;
}
