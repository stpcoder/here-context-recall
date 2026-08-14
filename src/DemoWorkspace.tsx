import {
  AppWindow,
  Bell,
  Check,
  ChevronDown,
  FileSpreadsheet,
  FolderOpen,
  Grid3X3,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Search,
  Send,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type WorkspaceApp = "desktop" | "excel" | "teams" | "outlook";
type OfficeApp = Exclude<WorkspaceApp, "desktop">;
type DemoPhase =
  | "starting"
  | "teams"
  | "checking"
  | "outlook"
  | "returned"
  | "complete";
type StoryCard = "intro" | "outro";
type HereState = "closed" | "loading" | "result";

const query = new URLSearchParams(window.location.search);
const fastDemo = query.get("fast") === "1";
const wait = (normal: number) => (fastDemo ? 40 : normal);

const columns = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
const sheetValues: Record<string, string> = {
  A2: "6월 인건비 마감",
  A3: "마감 전 계획 대비 실제 비용",
  A5: "구분",
  B5: "담당",
  C5: "계획",
  D5: "실제",
  E5: "증감",
  F5: "메모",
  A6: "인건비",
  B6: "재무기획",
  C6: "120",
  D6: "126",
  E6: "+6",
  F6: "급여·채용 일정 반영",
  A7: "외주비",
  B7: "구매",
  C7: "80",
  D7: "75",
  E7: "-5",
  F7: "계약 일정 변경",
  A8: "운영비",
  B8: "경영지원",
  C8: "46",
  D8: "44",
  E8: "-2",
  F8: "클라우드 비용 절감",
  A9: "마케팅",
  B9: "사업기획",
  C9: "38",
  D9: "41",
  E9: "+3",
  F9: "캠페인 조기 집행",
  A11: "합계",
  C11: "284",
  D11: "286",
  E11: "+2",
};

function OfficeIcon({
  app,
  size = 34,
}: {
  app: OfficeApp;
  size?: number;
}) {
  const Icon =
    app === "excel" ? FileSpreadsheet : app === "teams" ? MessageSquare : Mail;
  return (
    <span className={"demo-app-icon demo-app-" + app} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.55)} strokeWidth={2.2} />
    </span>
  );
}

function DesktopScene() {
  return (
    <section className="demo-desktop-scene" aria-label="Windows 바탕화면">
      <div className="demo-desktop-shortcuts">
        <div><span className="demo-folder-icon"><FolderOpen size={31} /></span><b>프로젝트 자료</b></div>
        <div><OfficeIcon app="excel" size={42} /><b>6월 실적.xlsx</b></div>
        <div><span className="demo-trash-icon"><Trash2 size={29} /></span><b>휴지통</b></div>
      </div>
      <div className="demo-desktop-clock" aria-hidden="true">
        <b>14:31</b>
        <span>2026년 6월 30일 화요일</span>
      </div>
    </section>
  );
}

function ExcelSheet({ selected }: { selected: boolean }) {
  const rows = useMemo(() => Array.from({ length: 18 }, (_, index) => index + 1), []);
  return (
    <section className="demo-excel" aria-label="6월 인건비 마감 Excel 통합 문서">
      <header className="demo-office-title demo-excel-title">
        <div className="demo-waffle"><Grid3X3 size={18} /></div>
        <OfficeIcon app="excel" size={27} />
        <strong>6월_인건비마감.xlsx</strong>
        <span className="demo-saved-state"><Check size={14} /> 저장됨</span>
        <label className="demo-office-search">
          <Search size={15} />
          <span>검색</span>
        </label>
        <div className="demo-profile">TH</div>
      </header>
      <nav className="demo-ribbon-tabs" aria-label="Excel 메뉴">
        <b>파일</b><span>홈</span><span>삽입</span><span>페이지 레이아웃</span>
        <span>수식</span><span>데이터</span><span>검토</span><span>보기</span>
      </nav>
      <div className="demo-ribbon">
        <div><b>붙여넣기</b><span>클립보드</span></div>
        <div><b>맑은 고딕 · 11</b><span>글꼴</span></div>
        <div><b>₩  %  ,</b><span>표시 형식</span></div>
        <div><b>조건부 서식</b><span>스타일</span></div>
        <div><b>정렬 및 필터</b><span>편집</span></div>
      </div>
      <div className="demo-formula-bar">
        <span className="demo-name-box">{selected ? "D6" : "A2"}</span>
        <b>fx</b>
        <span>{selected ? "126" : "6월 인건비 마감"}</span>
      </div>
      <div className="demo-sheet-wrap">
        <table className="demo-sheet">
          <thead>
            <tr>
              <th aria-hidden="true" />
              {columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row}>
                <th>{row}</th>
                {columns.map((column) => {
                  const coordinate = column + row;
                  const value = sheetValues[coordinate] || "";
                  const header = row === 5 && columns.indexOf(column) <= 5;
                  const total = row === 11 && columns.indexOf(column) <= 5;
                  const target = coordinate === "D6";
                  return (
                    <td
                      key={coordinate}
                      data-cell={coordinate}
                      className={[
                        header ? "is-table-header" : "",
                        total ? "is-total" : "",
                        selected && target ? "is-selected" : "",
                        column === "E" && row > 5 && row < 12 ? "is-change" : "",
                      ].filter(Boolean).join(" ")}
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="demo-sheet-tabs">
        <button aria-label="새 시트 추가">+</button>
        <button className="is-active">6월 인건비</button>
        <button>월별 상세</button>
        <span />
        <small>100%</small>
      </footer>
    </section>
  );
}

function TeamsScreen({
  onOpenWorkbook,
  replyDraft,
  replySent,
  onReplyChange,
  onReplySend,
}: {
  onOpenWorkbook: () => void;
  replyDraft: string;
  replySent: boolean;
  onReplyChange: (value: string) => void;
  onReplySend: () => void;
}) {
  return (
    <section className="demo-teams" aria-label="Microsoft Teams 재무팀 대화">
      <header className="demo-office-title demo-teams-title">
        <div className="demo-waffle"><Grid3X3 size={18} /></div>
        <OfficeIcon app="teams" size={27} />
        <label className="demo-office-search demo-teams-search">
          <Search size={15} />
          <span>검색</span>
        </label>
        <button aria-label="알림"><Bell size={18} /></button>
        <div className="demo-profile">TH</div>
      </header>
      <div className="demo-teams-layout">
        <nav className="demo-teams-rail" aria-label="Teams 주요 메뉴">
          <span><Bell size={20} /><small>활동</small></span>
          <span className="is-active"><MessageSquare size={20} /><small>채팅</small></span>
          <span><Video size={20} /><small>모임</small></span>
          <span><FolderOpen size={20} /><small>파일</small></span>
        </nav>
        <aside className="demo-chat-list">
          <div className="demo-chat-list-title"><b>채팅</b><button><MoreHorizontal size={18} /></button></div>
          <label className="demo-chat-filter"><Search size={14} /><span>최근 채팅 검색</span></label>
          <button className="demo-chat-person is-active">
            <span className="demo-avatar purple">MJ</span>
            <span><b>민지 · 재무팀</b><small>6월 실질 인건비 검토 부탁드려요.</small></span>
            <time>14:31</time>
          </button>
          <button className="demo-chat-person">
            <span className="demo-avatar blue">JS</span>
            <span><b>준서 · 사업기획</b><small>회의 자료 공유드립니다.</small></span>
            <time>13:52</time>
          </button>
          <button className="demo-chat-person">
            <span className="demo-avatar gray">YS</span>
            <span><b>유선 · 경영지원</b><small>확인했습니다.</small></span>
            <time>11:08</time>
          </button>
        </aside>
        <main className="demo-chat-main">
          <header className="demo-chat-header">
            <span className="demo-avatar purple">MJ</span>
            <div><b>민지 · 재무팀</b><small>온라인</small></div>
            <span />
            <button><Video size={18} /> 화상 통화</button>
            <button aria-label="더 보기"><MoreHorizontal size={18} /></button>
          </header>
          <div className="demo-chat-thread">
            <div className="demo-chat-day">오늘</div>
            <article className="demo-message incoming">
              <span className="demo-avatar purple">MJ</span>
              <div>
                <header><b>민지</b><time>14:31</time></header>
                <p>태호님, 6월 마감 전에 <strong>실질 인건비</strong> 검토 부탁드려요.</p>
                <button className="demo-file-card" onClick={onOpenWorkbook} aria-label="6월 인건비 마감 Excel 파일 열기">
                  <OfficeIcon app="excel" size={38} />
                  <span><b>6월_인건비마감.xlsx</b><small>Excel 통합 문서 · 24KB</small></span>
                  <span className="demo-open-file">열기</span>
                </button>
              </div>
            </article>
            {replySent && (
              <article className="demo-message outgoing">
                <div>
                  <header><b>태호</b><time>14:32</time></header>
                  <p>네, 6월 실질 인건비 검토해서 공유드릴게요.</p>
                </div>
                <span className="demo-avatar dark">TH</span>
              </article>
            )}
          </div>
          <footer className="demo-compose">
            <form onSubmit={(event) => { event.preventDefault(); onReplySend(); }}>
              <Paperclip size={18} />
              <input
                aria-label="답장 입력"
                placeholder="새 메시지 입력"
                value={replyDraft}
                onChange={(event) => onReplyChange(event.target.value)}
              />
              <button type="submit" aria-label="답장 보내기" disabled={!replyDraft.trim()}><Send size={18} /></button>
            </form>
          </footer>
        </main>
      </div>
    </section>
  );
}

function OutlookScreen() {
  return (
    <section className="demo-outlook" aria-label="Microsoft Outlook 받은 편지함">
      <header className="demo-office-title demo-outlook-title">
        <div className="demo-waffle"><Grid3X3 size={18} /></div>
        <OfficeIcon app="outlook" size={27} />
        <strong>Outlook</strong>
        <label className="demo-office-search demo-outlook-search"><Search size={15} /><span>검색</span></label>
        <button><Bell size={18} /></button>
        <div className="demo-profile">TH</div>
      </header>
      <div className="demo-outlook-layout">
        <aside className="demo-mail-folders">
          <button className="demo-new-mail">새 메일</button>
          <nav>
            <b>즐겨찾기</b>
            <span className="is-active">받은 편지함 <em>4</em></span>
            <span>보낸 편지함</span>
            <span>임시 보관함</span>
            <span>삭제된 항목</span>
          </nav>
        </aside>
        <aside className="demo-mail-list">
          <header><b>받은 편지함</b><button><ChevronDown size={15} /> 필터</button></header>
          <article className="is-active">
            <div><b>캘린더</b><time>14:34</time></div>
            <strong>곧 시작: 주간 사업 리뷰</strong>
            <p>오늘 14:40 · Finance 5F</p>
          </article>
          <article>
            <div><b>인사팀</b><time>13:48</time></div>
            <strong>하반기 사내 교육 안내</strong>
            <p>신규 교육 과정을 안내드립니다.</p>
          </article>
          <article>
            <div><b>프로젝트 알림</b><time>11:22</time></div>
            <strong>주간 진행 상황이 업데이트되었습니다</strong>
            <p>이번 주 마감 항목을 확인하세요.</p>
          </article>
        </aside>
        <main className="demo-reading-pane">
          <header>
            <span className="demo-calendar-date"><b>30</b><small>6월</small></span>
            <div><h1>주간 사업 리뷰</h1><p>오늘 14:40–15:10 · 회의실 5F</p></div>
          </header>
          <div className="demo-meeting-actions">
            <button className="is-primary">참석</button><button>미정</button><button>거절</button>
          </div>
          <div className="demo-mail-body">
            <p>이번 주 진행 현황과 주요 이슈를 함께 확인합니다.</p>
            <dl>
              <div><dt>주최자</dt><dd>준서 · 사업기획</dd></div>
              <div><dt>참석자</dt><dd>사업기획, 제품팀</dd></div>
              <div><dt>장소</dt><dd>회의실 5F</dd></div>
            </dl>
          </div>
        </main>
      </div>
    </section>
  );
}

function Notification({
  app,
  title,
  body,
  onClick,
}: {
  app: "teams" | "outlook";
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button className="demo-notification" onClick={onClick} aria-label={app === "teams" ? "Teams 알림 열기" : "Outlook 알림 열기"}>
      <OfficeIcon app={app} size={38} />
      <span><b>{title}</b><p>{body}</p></span>
      <time>지금</time>
    </button>
  );
}

function HereMark() {
  return <span className="demo-here-mark" aria-hidden="true"><i /><i /></span>;
}

function StoryCard({ variant }: { variant: StoryCard }) {
  return (
    <section className={"demo-story-card is-" + variant} aria-label={variant === "intro" ? "Here 인트로" : "Here 아웃트로"}>
      <div className="demo-story-brand"><HereMark /><b>Here</b></div>
      {variant === "intro" ? (
        <h1><span>복잡한 업무용 PC의 수많은 창 사이,</span><span>하던 일을 다시 찾아주는 솔루션, Here.</span></h1>
      ) : (
        <h1><span>잠시 멈춘 업무를 다시 이어드립니다.</span><strong className="demo-outro-wordmark">Here</strong></h1>
      )}
    </section>
  );
}

function TaskSwitcher({ selected }: { selected: number }) {
  const windows: Array<{
    app?: OfficeApp;
    icon?: typeof FolderOpen;
    title: string;
    meta: string;
  }> = [
    { app: "outlook" as const, title: "주간 사업 리뷰", meta: "Outlook" },
    { app: "excel" as const, title: "6월_인건비마감.xlsx", meta: "Excel" },
    { app: "teams" as const, title: "민지 · 재무팀", meta: "Microsoft Teams" },
    { icon: FolderOpen, title: "3분기 보고", meta: "파일 탐색기" },
    { icon: AppWindow, title: "사업기획 대시보드", meta: "Microsoft Edge" },
  ];

  return (
    <div className="demo-switcher-layer">
      <section className="demo-task-switcher" role="dialog" aria-label="열린 창 선택">
        <header><b>열린 창</b><kbd>Alt + Tab</kbd></header>
        <div className="demo-switcher-grid">
          {windows.map((window, index) => {
            const Icon = window.icon;
            return (
              <article className={selected === index ? "is-selected" : ""} key={window.title}>
                <div className="demo-switcher-preview">
                  {window.app ? <OfficeIcon app={window.app} size={46} /> : Icon ? <Icon size={36} /> : null}
                  <span>{window.title}</span>
                </div>
                <footer>
                  {window.app ? <OfficeIcon app={window.app} size={25} /> : Icon ? <Icon size={21} /> : null}
                  <span><b>{window.title}</b><small>{window.meta}</small></span>
                </footer>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function HerePanel({ onClose, onContinue }: { onClose: () => void; onContinue: () => void }) {
  const moments = [
    { time: "14:31", app: "teams" as const, title: "6월 실질 인건비 검토 요청" },
    { time: "14:32", app: "excel" as const, title: "6월_인건비마감.xlsx 열기" },
    { time: "14:34", app: "outlook" as const, title: "회의 알림을 확인하며 잠시 이탈" },
    { time: "14:36", app: "excel" as const, title: "6월 인건비 마감으로 복귀" },
  ];
  return (
    <div className="demo-here-layer">
      <aside className="demo-here-panel" role="dialog" aria-label="Here 업무 인수인계">
        <header>
          <div><HereMark /><b>Here</b></div>
          <button onClick={onClose} aria-label="Here 닫기"><X size={19} /></button>
        </header>
        <div className="demo-here-current">
          <OfficeIcon app="excel" size={34} />
          <span><b>6월_인건비마감.xlsx</b><small>방금 다시 열었습니다</small></span>
        </div>
        <h2>6월 실질 인건비를 검토하려고 이 파일을 열었어요.</h2>
        <p className="demo-here-origin">민지님의 Teams 요청에서 시작됐습니다.</p>
        <ol className="demo-context-chain">
          {moments.map((moment, index) => (
            <li key={moment.time}>
              <time>{moment.time}</time>
              <OfficeIcon app={moment.app} size={32} />
              <div><b>{moment.title}</b><small>{index === 2 ? "다른 업무" : index === 3 ? "현재 창" : "확인된 기록"}</small></div>
            </li>
          ))}
        </ol>
        <div className="demo-target">
          <span>확인할 위치</span>
          <b>6월 인건비 · D6</b>
          <p>실질 인건비 검토 위치</p>
        </div>
        <button className="demo-continue-button" onClick={onContinue} aria-label="검토하던 곳으로 이동">
          검토하던 곳으로 이동
        </button>
      </aside>
    </div>
  );
}

function HereLoadingPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="demo-here-layer">
      <aside className="demo-here-panel is-loading" role="dialog" aria-label="Here가 하던 일을 찾고 있습니다">
        <header>
          <div><HereMark /><b>Here</b></div>
          <button onClick={onClose} aria-label="Here 닫기"><X size={19} /></button>
        </header>
        <div className="demo-here-loading" role="status" aria-live="polite">
          <div className="demo-context-loader" aria-hidden="true"><i /><i /><i /></div>
          <h2>하던 일을 찾고 있습니다</h2>
        </div>
      </aside>
    </div>
  );
}

function Taskbar({ active, onExcel }: { active: WorkspaceApp; onExcel: () => void }) {
  return (
    <footer className="demo-taskbar" aria-label="Windows 작업 표시줄">
      <button className="demo-windows" aria-label="시작"><span /><span /><span /><span /></button>
      <button className={active === "excel" ? "is-active" : ""} onClick={onExcel} aria-label="작업 표시줄에서 Excel 열기"><OfficeIcon app="excel" size={35} /></button>
      <button className={active === "teams" ? "is-active" : ""} aria-label="Teams"><OfficeIcon app="teams" size={35} /></button>
      <button className={active === "outlook" ? "is-active" : ""} aria-label="Outlook"><OfficeIcon app="outlook" size={35} /></button>
      <span className="demo-taskbar-spacer" />
      <div className="demo-system"><span>ENG</span><b>14:36</b><small>2026-06-30</small></div>
    </footer>
  );
}

export default function DemoWorkspace() {
  const [app, setApp] = useState<WorkspaceApp>("desktop");
  const [phase, setPhase] = useState<DemoPhase>("starting");
  const [notice, setNotice] = useState<"teams" | "outlook" | null>(null);
  const [hereState, setHereState] = useState<HereState>("closed");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherIndex, setSwitcherIndex] = useState(-1);
  const [storyCard, setStoryCard] = useState<StoryCard | null>("intro");
  const [replyDraft, setReplyDraft] = useState("");
  const [replySent, setReplySent] = useState(false);

  useEffect(() => {
    let noticeTimer = 0;
    const introTimer = window.setTimeout(() => {
      setStoryCard(null);
      noticeTimer = window.setTimeout(() => setNotice("teams"), wait(3_200));
    }, wait(4_500));
    return () => {
      window.clearTimeout(introTimer);
      window.clearTimeout(noticeTimer);
    };
  }, []);

  useEffect(() => {
    if (phase !== "complete") return;
    const timer = window.setTimeout(() => setStoryCard("outro"), fastDemo ? 600 : 7_000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (hereState !== "loading") return;
    const timer = window.setTimeout(() => setHereState("result"), fastDemo ? 320 : 2_200);
    return () => window.clearTimeout(timer);
  }, [hereState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (phase !== "outlook" || event.key !== "Tab" || !event.altKey) return;
      event.preventDefault();
      setSwitcherOpen(true);
      setSwitcherIndex((current) => {
        if (current < 0) return 1;
        return event.shiftKey ? (current + 4) % 5 : (current + 1) % 5;
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Alt" || !switcherOpen) return;
      setSwitcherOpen(false);
      if (switcherIndex === 1) {
        setApp("excel");
        setPhase("returned");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [phase, switcherIndex, switcherOpen]);

  const openTeams = () => {
    setNotice(null);
    setApp("teams");
    setPhase("teams");
  };

  const openWorkbook = () => {
    setApp("excel");
    setPhase("checking");
    window.setTimeout(() => setNotice("outlook"), wait(3_600));
  };

  const sendReply = () => {
    if (!replyDraft.trim()) return;
    setReplyDraft("");
    setReplySent(true);
  };

  const openOutlook = () => {
    setNotice(null);
    setApp("outlook");
    setPhase("outlook");
  };

  const returnToExcel = () => {
    setApp("excel");
    if (phase === "outlook") {
      setPhase("returned");
    }
  };

  const finishRecall = () => {
    setHereState("closed");
    setPhase("complete");
  };

  const showBubble = phase === "returned";
  const selected = phase === "complete";

  return (
    <main className="demo-desktop" data-demo-phase={phase}>
      <div className="demo-wallpaper" aria-hidden="true" />
      {app === "desktop" ? (
        <DesktopScene />
      ) : (
        <div className="demo-window">
          {app === "excel" && <ExcelSheet selected={selected} />}
          {app === "teams" && (
            <TeamsScreen
              onOpenWorkbook={openWorkbook}
              replyDraft={replyDraft}
              replySent={replySent}
              onReplyChange={setReplyDraft}
              onReplySend={sendReply}
            />
          )}
          {app === "outlook" && <OutlookScreen />}
        </div>
      )}

      {notice === "teams" && (
        <Notification
          app="teams"
          title="민지 · 재무팀"
          body="6월 마감 전 실질 인건비 검토 부탁드려요."
          onClick={openTeams}
        />
      )}
      {notice === "outlook" && (
        <Notification
          app="outlook"
          title="10분 뒤 시작"
          body="주간 사업 리뷰 · 회의실 5F"
          onClick={openOutlook}
        />
      )}

      {showBubble && hereState === "closed" && (
        <button className="demo-here-bubble" onClick={() => setHereState("loading")} aria-label="왜 이 창을 열었는지 확인">
          <HereMark />
          <span>왜 이 창을 열었지?</span>
        </button>
      )}

      {hereState === "loading" && <HereLoadingPanel onClose={() => setHereState("closed")} />}
      {hereState === "result" && <HerePanel onClose={() => setHereState("closed")} onContinue={finishRecall} />}
      {switcherOpen && <TaskSwitcher selected={switcherIndex} />}

      {selected && (
        <div className="demo-success" role="status">
          <Check size={18} />
          <span><b>실질 인건비 검토 위치</b>로 돌아왔어요.</span>
        </div>
      )}

      <Taskbar active={app} onExcel={returnToExcel} />
      {storyCard && <StoryCard variant={storyCard} />}
    </main>
  );
}
