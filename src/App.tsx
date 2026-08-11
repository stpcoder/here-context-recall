import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  Eye,
  EyeOff,
  ExternalLink,
  LoaderCircle,
  Pause,
  Play,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ActivityEvent,
  DesktopBootstrap,
  PublicSettings,
  RecallState,
} from "../electron/shared/contracts";

type Surface = "bubble" | "recall" | "settings";

const api = window.here;

function getSurface(): Surface {
  const value = new URLSearchParams(window.location.search).get("surface");
  return value === "bubble" || value === "settings" ? value : "recall";
}

function time(value?: number) {
  if (!value) return "방금";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function appLabel(event?: ActivityEvent) {
  return event?.appName || "알 수 없는 앱";
}

function titleLabel(event?: ActivityEvent) {
  if (!event) return "";
  return event.titleRedacted ? "제목은 가려짐" : event.title || "창 제목 없음";
}

function sourceLabel(state: RecallState) {
  return state.reconstruction?.source === "model" ? "연결한 모델" : "관찰 기록";
}

function EmptyState({ onSettings }: { onSettings: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-mark">
        <Clock3 size={22} />
      </div>
      <p className="eyebrow">아직 단서가 없어요</p>
      <h1>
        잠시 일한 뒤,
        <br />
        다시 물어보세요.
      </h1>
      <p className="muted">
        Here는 허용 후 최근 활성 앱과 창 제목만
        <br />
        기기에 잠시 보관합니다.
      </p>
      <button className="text-action" onClick={onSettings}>
        캡처 설정 <ChevronRight size={15} />
      </button>
    </div>
  );
}

function Bubble() {
  const [expanded, setExpanded] = useState(false);
  const [stats, setStats] = useState<DesktopBootstrap["stats"]>();
  useEffect(() => {
    void api.bootstrap().then((data) => setStats(data.stats));
    return api.onActivity((event) => {
      if (event.kind === "monitor-paused")
        setStats((current) =>
          current ? { ...current, paused: true } : current,
        );
      if (event.kind === "monitor-resumed")
        setStats((current) =>
          current ? { ...current, paused: false } : current,
        );
    });
  }, []);
  const change = (next: boolean) => {
    setExpanded(next);
    void api.setBubbleExpanded(next);
  };
  return (
    <motion.button
      className={`bubble ${expanded ? "is-expanded" : ""}`}
      aria-label="Why am I here? 최근 업무 흐름 보기"
      onMouseEnter={() => change(true)}
      onMouseLeave={() => change(false)}
      onFocus={() => change(true)}
      onBlur={() => change(false)}
      onClick={() => void api.recall("bubble")}
      initial={{ opacity: 0, scale: 0.82 }}
      animate={{ opacity: 1, scale: 1 }}
    >
      <span className="bubble-dot">
        <span />
      </span>
      <span className="bubble-copy">Why am I here?</span>
      {stats?.paused && <span className="bubble-paused">paused</span>}
    </motion.button>
  );
}

function Chain({ state }: { state: RecallState }) {
  const chain = state.explanation?.chain ?? [];
  return (
    <ol className="chain" aria-label="관찰한 업무 흐름">
      {chain.map((step, index) => (
        <motion.li
          key={step.eventId}
          className={`chain-item chain-${step.role}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12 + index * 0.07, duration: 0.32 }}
        >
          <time>{time(step.timestamp)}</time>
          <span className="chain-rail">
            <i />
          </span>
          <div>
            <strong>{step.label}</strong>
            <small>
              {step.role === "interruption"
                ? "작업이 잠시 끊김"
                : step.role === "return"
                  ? "다시 돌아온 창"
                  : "활성 창 전환"}
            </small>
          </div>
        </motion.li>
      ))}
    </ol>
  );
}

function RecallPanel() {
  const [state, setState] = useState<RecallState>();
  const [stats, setStats] = useState<DesktopBootstrap["stats"]>();
  const [settings, setSettings] = useState<PublicSettings>();
  const refresh = useCallback(async () => {
    const boot = await api.bootstrap();
    setState(boot.recall);
    setStats(boot.stats);
    setSettings(boot.settings);
  }, []);
  useEffect(() => {
    void refresh();
    return api.onRecall(setState);
  }, [refresh]);
  const dismiss = () => void api.dismissRecall();
  const pause = async () => {
    const next = stats?.paused
      ? await api.resumeCapture()
      : await api.pauseCapture();
    setStats(next);
  };
  const heading = state?.reconstruction?.summary || state?.explanation?.answer;
  const nextAction =
    state?.reconstruction?.nextAction || state?.explanation?.nextAction;
  const hasEvidence = Boolean(state?.explanation?.chain.length);
  return (
    <main className="recall-shell">
      <header className="panel-topbar">
        <div className="wordmark">
          here<span>.</span>
        </div>
        <div className="topbar-actions">
          {stats?.paused ? (
            <span className="paused-chip">일시 정지</span>
          ) : (
            <span className="quiet-chip">
              <i /> 최근 {settings?.retentionMinutes ?? 10}분
            </span>
          )}
          <button
            className="icon-button"
            onClick={() => void api.openSettings()}
            aria-label="설정 열기"
          >
            <Settings2 size={17} />
          </button>
          <button className="icon-button" onClick={dismiss} aria-label="닫기">
            <X size={18} />
          </button>
        </div>
      </header>

      <AnimatePresence mode="wait">
        {state?.status === "loading" ? (
          <motion.section
            key="loading"
            className="recall-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <LoaderCircle className="spinner" size={21} />
            <p>방금 전 흐름을 잇는 중</p>
            <small>관찰한 창 전환만 확인하고 있어요</small>
          </motion.section>
        ) : !hasEvidence ? (
          <motion.section
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <EmptyState onSettings={() => void api.openSettings()} />
          </motion.section>
        ) : (
          <motion.section
            key="result"
            className="recall-content"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <div className="result-label">
              <Sparkles size={13} /> {sourceLabel(state!)} · 근거{" "}
              {state!.explanation!.evidenceIds.length}개
            </div>
            <h1>{heading}</h1>
            {state?.current && (
              <div className="current-window">
                <span>현재</span>
                <b>{appLabel(state.current)}</b>
                <em>{titleLabel(state.current)}</em>
              </div>
            )}
            <Chain state={state!} />
            {state?.message && <p className="error-note">{state.message}</p>}
            <footer className="recall-footer">
              <button className="primary-action" onClick={dismiss}>
                {nextAction || "이 작업으로 돌아가기"}
                <ArrowRight size={17} />
              </button>
              <button className="secondary-action" onClick={() => void pause()}>
                {stats?.paused ? <Play size={15} /> : <Pause size={15} />}
                {stats?.paused ? "다시 기록" : "잠시 멈춤"}
              </button>
            </footer>
          </motion.section>
        )}
      </AnimatePresence>
    </main>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  detail,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  detail?: string;
}) {
  return (
    <label className="toggle-row">
      <span>
        <b>{label}</b>
        {detail && <small>{detail}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
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
  const update = <K extends keyof PublicSettings>(
    field: K,
    value: PublicSettings[K],
  ) =>
    setSettings((current) =>
      current ? { ...current, [field]: value } : current,
    );
  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setNotice(undefined);
    try {
      const next = await api.saveSettings({
        settings: {
          endpoint: settings.endpoint,
          model: settings.model,
          captureConsent: settings.captureConsent,
          shortcut: settings.shortcut,
          retentionMinutes: settings.retentionMinutes,
          excludedApps: exclude
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
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
    setNotice("연결 확인 중…");
    try {
      const result = await api.testConnection({
        endpoint: settings.endpoint,
        model: settings.model,
        apiKey: key || undefined,
      });
      setNotice(
        result.ok
          ? `연결됨${result.models.length ? ` · ${result.models.length}개 모델` : ""}`
          : result.error || "연결하지 못했어요",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "연결하지 못했어요");
    }
  };
  const removeKey = async () => {
    try {
      const next = await api.saveSettings({ settings: {}, clearApiKey: true });
      setSettings(next);
      setKey("");
      setNotice("저장된 키를 지웠어요");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "키를 지우지 못했어요",
      );
    }
  };
  const clearHistory = async () => {
    try {
      await api.clearHistory();
      setNotice("최근 기록을 지웠어요");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "기록을 지우지 못했어요",
      );
    }
  };
  if (!settings)
    return (
      <main className="settings-shell">
        <div className="settings-loading">
          <LoaderCircle className="spinner" />
        </div>
      </main>
    );
  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div>
          <div className="wordmark">
            here<span>.</span>
          </div>
          <p>지금 이 창에 온 이유를, 다시 잊지 않게.</p>
        </div>
        <button
          className="icon-button"
          onClick={() => void api.closeSettings()}
          aria-label="닫기"
        >
          <X size={18} />
        </button>
      </header>
      <div className="settings-scroll">
        <section className="consent-card">
          <ShieldCheck size={18} />
          <div>
            <p className="eyebrow">개인정보 보호</p>
            <h2>화면을 보지 않습니다.</h2>
            <p>
              활성 앱 이름과 창 제목 전환만 최근 {settings.retentionMinutes}분
              동안 이 기기에 보관합니다. 스크린샷, 키 입력, 문서 본문은 수집하지
              않습니다.
            </p>
          </div>
          <Toggle
            checked={settings.captureConsent}
            onChange={(value) => update("captureConsent", value)}
            label="창 흐름 기록 허용"
          />
        </section>

        <section className="setting-section">
          <div className="section-title">
            <span>모델 연결</span>
            <small>OpenAI 호환 · vLLM 지원</small>
          </div>
          <label className="field">
            <span>Endpoint</span>
            <input
              value={settings.endpoint}
              onChange={(event) => update("endpoint", event.target.value)}
              placeholder="http://127.0.0.1:8000/v1"
            />
          </label>
          <label className="field">
            <span>Model</span>
            <input
              value={settings.model}
              onChange={(event) => update("model", event.target.value)}
              placeholder="Qwen/Qwen2.5-7B-Instruct"
            />
          </label>
          <label className="field">
            <span>
              API key <em>{settings.apiKeyConfigured ? "저장됨" : "선택"}</em>
            </span>
            <div className="key-input">
              <input
                type={showKey ? "text" : "password"}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder={
                  settings.apiKeyConfigured
                    ? "새 키를 입력하면 교체합니다"
                    : "제품 내부에 암호화 저장"
                }
                autoComplete="off"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                aria-label={showKey ? "키 숨기기" : "키 보기"}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>
          <div className="inline-actions">
            <button className="test-button" onClick={() => void test()}>
              <ExternalLink size={14} /> 연결 확인
            </button>
            {settings.apiKeyConfigured && (
              <button
                className="test-button muted-action"
                onClick={() => void removeKey()}
              >
                저장된 키 삭제
              </button>
            )}
          </div>
        </section>

        <section className="setting-section">
          <div className="section-title">
            <span>기록 범위</span>
            <small>언제든 수정 가능</small>
          </div>
          <label className="field">
            <span>보관 시간</span>
            <select
              value={settings.retentionMinutes}
              onChange={(event) =>
                update("retentionMinutes", Number(event.target.value))
              }
            >
              <option value={5}>최근 5분</option>
              <option value={10}>최근 10분</option>
              <option value={15}>최근 15분</option>
            </select>
          </label>
          <label className="field">
            <span>제외할 앱</span>
            <input
              value={exclude}
              onChange={(event) => setExclude(event.target.value)}
              placeholder="예: 1Password, Bitwarden"
            />
            <small>쉼표로 구분합니다.</small>
          </label>
          <Toggle
            checked={settings.showBubble}
            onChange={(value) => update("showBubble", value)}
            label="화면 버튼 표시"
            detail="활성 창 옆의 작은 Here 버튼"
          />
          <Toggle
            checked={settings.autoStart}
            onChange={(value) => update("autoStart", value)}
            label="로그인 시 시작"
          />
          <div className="shortcut-row">
            <span>바로 열기</span>
            <kbd>
              {desktop?.platform === "darwin" ? "⌘ ⇧ Space" : "Ctrl ⇧ Space"}
            </kbd>
            {desktop && !desktop.shortcutRegistered && (
              <em>다른 단축키와 충돌</em>
            )}
          </div>
          <button className="danger-button" onClick={() => void clearHistory()}>
            <Trash2 size={14} /> 최근 기록 지우기
          </button>
        </section>
      </div>
      <footer className="settings-footer">
        <span>{notice}</span>
        <button
          className="save-button"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? (
            <LoaderCircle className="spinner" size={15} />
          ) : (
            <Check size={16} />
          )}{" "}
          저장
        </button>
      </footer>
    </main>
  );
}

export default function App() {
  const surface = useMemo(getSurface, []);
  if (surface === "bubble") return <Bubble />;
  if (surface === "settings") return <SettingsPanel />;
  return <RecallPanel />;
}
