# Here 기술 핵심 설계 — Work Trace와 역방향 원인 추적

## 한 문장

**여러 프로그램을 오가는 업무에 Trace ID를 부여하고, 현재 창에서 시작해 그 창을 열게 만든 사건만 역방향으로 찾아냅니다.**

## 기술 착안점

화면 한 장에는 그 창을 연 이유가 남아 있지 않습니다. 이유는 창과 창 사이의 이동에 남습니다. Teams 요청을 읽고 곧바로 Excel을 열었다면 `Teams → Excel`이라는 전환이 첫 번째 근거가 됩니다. Excel을 보다가 Outlook 알림을 열고 다시 같은 Excel로 돌아왔다면 `Excel → Outlook → Excel`이 두 번째 근거가 됩니다.

Here는 각 화면을 독립된 기록으로 모으지 않고, **창 전환을 원인과 결과의 관계로 기록**합니다. 한 업무에 포함된 창에는 같은 `Work Trace ID`가 붙습니다. 사용자가 Here를 누르면 현재 창을 기준점으로 두고 그래프를 뒤로 따라갑니다. 프로그램 디버거가 특정 값에 영향을 준 코드만 찾는 역방향 슬라이싱과 같은 방식입니다.

```text
Work Trace T-204
14:31 Teams  재무팀의 6월 실질 인건비 검토 요청  ← 시작
14:32 Excel  6월_인건비마감.xlsx                 ← 같은 업무

Work Trace T-205
14:34 Outlook 주간 사업 리뷰                      ← 별도 일정 확인

14:36 Excel  6월_인건비마감.xlsx                 ← T-204 다시 활성화
```

현재 Excel의 이유를 물으면 최근 10분 전체를 모델에 던지지 않습니다. 현재 Excel 노드에서 `T-204`의 부모를 거슬러 올라가 시작점인 Teams 요청만 꺼냅니다. 현재 Excel의 원인 경로에 없는 창은 제외하고, Outlook은 `Excel → Outlook → Excel`로 닫힌 우회 구간이므로 잠시 자리를 비운 이유로만 표시합니다.

```text
전체 기록: Teams → Excel → Chrome → Outlook → 메모장 → Excel

현재 Excel의 역방향 결과
원인:       Teams → Excel ─────────────→ Excel
우회 구간:                  Outlook
제외:              Chrome             메모장
```

이 선택 과정이 Here의 기술 Wow입니다. 모델의 자연어 능력으로 그럴듯한 이유를 만드는 방식이 아니라, **현재 창에 영향을 준 사건만 먼저 계산한 뒤 AI가 그 결과를 설명**합니다.

## 동작 로직

### 0. 화면보다 앱 사이의 전달 사건을 먼저 기록합니다

기록의 기본 단위는 화면 이미지가 아니라 `Handoff Edge`입니다. 한 프로그램에서 파일·링크·버튼을 실행하고 다른 프로그램이 활성화된 짧은 구간을 전환 하나로 묶습니다.

```ts
type HandoffEdge = {
  edgeId: string;
  fromSpanId: string;
  toSpanId: string;
  relation: TransitionRelation;
  artifactFingerprint?: string;
  evidence: Array<{
    id: string;
    kind: "same-artifact" | "exact-return" | "new-window" | "time" | "shared-anchor";
    strength: "exact" | "strong" | "supporting";
  }>;
};
```

Teams 첨부파일의 로컬 경로 또는 SharePoint/OneDrive 자원 ID와 Excel에서 열린 통합 문서의 자원 ID가 같으면 `same-artifact`가 됩니다. 자원 ID가 없을 때는 파일명·크기·수정 시각을 조합한 fingerprint를 로컬에서 해시합니다. 파일 본문은 읽지 않습니다. 같은 자원 증거가 있으면 의미 모델을 호출하지 않고 두 창을 같은 업무로 확정합니다.

Windows에서는 UI Automation의 `UIA_Invoke_InvokedEventId`를 선택적으로 구독합니다. 접근성 기능을 지원하는 첨부파일·링크·버튼이 실제로 실행되면 해당 요소의 이름과 앱, 시각을 짧게 캐시합니다. 이어서 `EVENT_SYSTEM_FOREGROUND` 또는 `UIA_Window_WindowOpenedEventId`가 발생하면 새 창과 비교합니다. 마우스 좌표나 키 입력을 수집하지 않고, 컨트롤이 실행됐다는 사건만 받습니다. UI Automation 요소는 실행 직후 트리에서 사라질 수 있으므로 이벤트 구독 시 Name·ControlType·AutomationId를 cache request로 미리 받아 둡니다.

### 1. 창을 사용한 구간을 Span으로 만듭니다

활성 창이 바뀔 때마다 다음 정보로 `Window Span`을 만듭니다.

```ts
type WindowSpan = {
  spanId: string;
  workTraceId: string;
  parentSpanId?: string;
  app: string;
  windowFingerprint: string;
  titleAnchors: string[];
  startedAt: number;
  endedAt?: number;
};
```

`windowFingerprint`는 앱 이름, 창 식별자, 정규화한 문서 제목으로 만듭니다. `titleAnchors`에는 파일명, 날짜, 프로젝트명, 사람 이름처럼 여러 프로그램에서 다시 나타날 수 있는 단서만 담습니다. 원본 제목은 최근 기록 보관 시간이 끝나면 함께 삭제합니다.

### 2. 전환이 같은 업무인지 판정합니다

새 창이 나타나면 이전 창과의 `Transition Edge`를 평가합니다.

| 확인하는 신호 | 의미 |
| --- | --- |
| 동일 자원 | 메시지의 첨부파일과 열린 문서가 같은 파일인지 확인 |
| 전환 간격 | 요청을 본 직후 열린 창인지 확인 |
| 공통 단서 | `6월`, `인건비`, 파일명처럼 두 창에 함께 나타난 표현 확인 |
| 새로 열린 창 | 기존 창 선택인지, 요청 직후 새 문서가 열린 것인지 확인 |
| 정확한 복귀 | 같은 앱과 문서 제목의 창으로 돌아왔는지 확인 |
| 머문 시간 | 잠깐 확인한 알림인지, 새 업무를 시작한 것인지 확인 |
| 보호 구간 | 내용이 가려진 앱은 추론 근거에서 제외하고 빈 구간으로 유지 |

판정 결과는 네 가지입니다.

```ts
type TransitionRelation =
  | "continue"   // 같은 Work Trace ID를 전달
  | "interrupt"  // 현재 업무를 보류하고 새 업무 ID 생성
  | "return"     // 보류된 업무 ID를 다시 활성화
  | "new";       // 독립된 새 업무 시작
```

확실한 복귀와 문서 일치는 로컬 규칙으로 판정합니다. 애매한 전환만 사내 vLLM에 보냅니다. 모델은 `continue | interrupt | new` 중 하나와 사용한 근거 ID만 JSON으로 반환합니다. 모델이 기록에 없는 창이나 이유를 추가할 수 없도록 제한합니다.

판정은 아래 증거 순서를 지킵니다.

1. **Exact:** 동일 자원 ID 또는 같은 창·문서로의 정확한 복귀
2. **Strong:** 새 창 생성, 1.5초 이내 전환, 파일 fingerprint 일치
3. **Supporting:** 파일명·날짜·업무 대상의 공통 단서와 머문 시간
4. **Ambiguous:** 위 증거가 충돌할 때만 vLLM 분류

`Exact` 하나가 있으면 연결을 확정합니다. `Strong`은 두 개 이상일 때 확정합니다. `Supporting`만 있을 때는 자동 연결하지 않고 vLLM 판정 또는 별도 업무로 남깁니다. 이를 통해 `6월`처럼 흔한 단어만 같다는 이유로 서로 다른 업무를 붙이는 오류를 막습니다.

초기 MVP에서는 아래 우선순위로 관계를 확정합니다.

```ts
function relate(previous: WindowSpan, next: WindowSpan): TransitionRelation {
  if (matchesSuspendedWindow(next)) return "return";
  if (exactDocumentMatch(previous, next)) return "continue";
  if (openedWithin(next, 1_500) && sharesStrongAnchor(previous, next))
    return "continue";
  if (isClosedDetour(previous, next)) return "interrupt";
  return "new";
}
```

`openedWithin`은 이전 창을 사용한 직후 새 창이 실제로 나타난 경우에만 참입니다. `sharesStrongAnchor`는 일반 단어가 아니라 파일명 stem, 사번·프로젝트 코드, 날짜와 업무 대상처럼 구별력이 있는 단서를 사용합니다. 점수가 애매하면 연결을 억지로 만들지 않고 별도 업무로 보관합니다.

### 3. 중단된 업무를 보류 목록에 둡니다

Outlook 알림처럼 다른 업무가 시작되면 기존 Trace를 삭제하지 않고 `suspended` 상태로 둡니다. 같은 창의 fingerprint가 다시 나타나면 해당 Trace를 바로 활성화합니다. 여러 업무를 차례로 열어도 fingerprint 인덱스로 원하는 Trace를 찾을 수 있어 마지막 업무부터 돌아가야 한다는 제약이 없습니다.

```text
active:     T-205  Outlook 회의 일정
suspended:  T-204  Teams 요청 → Excel 실제값 확인

Excel 복귀 감지
active:     T-204  Teams 요청 → Excel 실제값 확인
suspended:  T-205  Outlook 회의 일정
```

### 4. 현재 Trace에서만 답을 만듭니다

Here가 보여주는 세 가지는 활성 Trace에서 직접 가져옵니다.

- 창을 연 이유: Trace의 첫 요청 또는 처음 열린 업무 창
- 멈춘 곳: 중단 직전 마지막 Span
- 다음 할 일: 마지막 Span의 작업 위치 또는 마지막으로 확인한 대상

역방향 탐색은 아래 순서로 진행합니다.

1. 현재 창의 fingerprint와 일치하는 최근 Span을 찾습니다.
2. 해당 Span의 `return` 간선을 따라 중단 직전의 같은 창으로 이동합니다.
3. `continue` 간선만 부모 방향으로 따라가 최초 요청을 찾습니다.
4. 닫힌 `interrupt` 구간은 원인 경로와 분리해 표시합니다.
5. 근거가 약한 간선 또는 관련 없는 가지는 결과에서 제외합니다.

```ts
type CausalSlice = {
  traceId: string;
  rootEvidenceId: string;
  workEvidenceIds: string[];
  detourEvidenceIds: string[];
  excludedEventCount: number;
  confidence: "exact" | "supported" | "uncertain";
};
```

결과 화면과 모델 요청은 같은 `CausalSlice`를 사용합니다. 따라서 사용자가 보는 기록과 모델이 설명에 사용한 기록이 다르게 움직이지 않습니다.

Windows 기본 수집만 사용하면 파일과 창 수준까지 정확하게 안내합니다. Excel의 시트와 셀처럼 프로그램 내부 위치는 사용자가 별도로 허용한 앱 어댑터에서 가져옵니다. Excel 어댑터는 통합 문서명, 시트명, 활성 셀 주소만 기록하고 셀 내용은 수집하지 않는 방식으로 구성합니다.

### 요청 문장을 확보하는 안전한 입력

창 제목만으로는 “6월 마감 전에 실질 인건비를 검토해 주세요”라는 요청 문장을 안정적으로 얻을 수 없습니다. 메시지 본문이 필요한 조직은 다음 입력 중 하나를 명시적으로 켭니다.

| 입력 방식 | 얻는 정보 | 권한과 범위 |
| --- | --- | --- |
| UI Automation 실행 이벤트 | 사용자가 실행한 첨부파일·링크·버튼의 이름과 시각 | 앱이 접근성 이벤트를 제공할 때 사용 |
| Windows 알림 수신기 | 최근 표시된 알림의 앱·표시 문구·시각 | Windows의 별도 사용자 허용이 필요하며 클릭 확정 신호로는 사용하지 않음 |
| Teams 조직 어댑터 | 사용자가 연 채팅의 요청 메시지 | Microsoft Graph 위임 권한과 조직 승인 필요 |
| Here 공유 메뉴 | 사용자가 선택해 Here로 보낸 메시지 | 자동 수집 없음 |

해커톤 MVP의 정확한 시작 신호는 **Teams에서 첨부파일 또는 링크가 실행된 사건**입니다. UI Automation 실행 이벤트의 요소 이름과 뒤이어 열린 Excel 파일명이 일치하면 두 창을 같은 업무로 확정합니다. 최근 표시된 Windows 알림은 Teams로 이동한 이유를 보조하지만, 다른 앱이 알림 클릭 자체를 확정적으로 받을 수 없으므로 `Exact` 증거로 사용하지 않습니다. 요청 문장까지 정확히 보여주는 조직 데모는 Teams 위임 권한을 받은 Graph 어댑터 또는 사용자가 직접 선택하는 Here 공유 메뉴를 사용합니다.

Excel 어댑터는 선택 변경 이벤트에서 시트 이름과 `Range.Address`만 받습니다. 셀의 표시값이나 수식은 읽지 않습니다. 사용자가 돌아오면 해당 통합 문서와 셀 주소로 포커스를 돌리는 기능을 별도 동의 아래 제공합니다.

### 앱 어댑터가 제공하는 공통 계약

```ts
type AppAnchor = {
  app: "teams" | "excel" | "outlook" | "browser";
  observedAt: number;
  action: "request-opened" | "artifact-invoked" | "artifact-opened" | "selection-changed" | "notification-opened";
  artifactFingerprint?: string;
  location?: { document: string; section?: string; position?: string };
  textHint?: string;
  source: "window" | "notification" | "uia-invoke" | "graph" | "office-adapter";
};
```

공통 엔진은 앱의 본문 구조를 알지 못합니다. 각 어댑터가 최소 단서만 `AppAnchor`로 전달합니다. `textHint`가 포함되는 알림과 메시지는 별도 동의를 받은 입력에서만 사용합니다. 원본은 짧은 보존 시간이 끝나면 삭제하고 fingerprint는 로컬 해시로 보관합니다.

## 사내 vLLM의 역할

OpenAI-compatible vLLM은 두 지점에만 사용합니다.

1. 규칙만으로 구분하기 어려운 창 전환의 관계 판정
2. 확정된 Trace를 자연스러운 인수인계 문장으로 작성

모델 요청에는 활성 Trace에서 선택한 이벤트와 ID만 포함합니다. 응답의 `evidenceIds`가 실제 요청에 포함된 ID인지 검사한 뒤 화면에 표시합니다. 연결이 실패하면 로컬 판정 결과를 그대로 보여줍니다.

## 현재 구현과 다음 구현

현재 데스크톱 앱에는 다음 기반이 이미 구현되어 있습니다.

- Windows와 macOS 활성 창, 제목, 사용 시각 수집
- 동일한 창으로 돌아오는 `A → 다른 창 → A` 탐지
- 최대 10분 메모리 보관과 민감 앱 제외
- Window Span 그래프 생성과 현재 창 기준 역방향 선택
- 동일 자원과 정확한 문서 복귀 증거 확인, 제외된 창 집계
- 근거 ID를 제한한 OpenAI-compatible vLLM 요청
- 모델 연결 실패 시 로컬 결과 표시

현재 패키지 수집기는 앱 이름·창 제목·전환 시각을 Work Trace Engine에 전달합니다. UI Automation과 Office 어댑터가 제공하는 `same-artifact` 입력은 테스트 fixture로 검증했으며 아직 패키지 수집기에 연결하지 않았습니다. 따라서 현재 런타임은 제목 단서만으로 선택한 결과를 진단에 표시할 수 있지만, 동일 자원이 확인되지 않으면 그 결과로 모델 입력을 줄이지 않습니다.

다음 단계는 현재의 `A → 다른 창 → A` 탐지를 아래 순서로 확장합니다.

1. 창 이벤트를 Window Span으로 변환
2. 파일명·날짜·업무 표현에서 공통 단서 추출
3. 전환마다 Work Trace ID를 전달하거나 새로 발급
4. 보류된 Trace를 window fingerprint로 다시 활성화
5. 활성 Trace의 첫 원인과 마지막 작업을 vLLM에 전달

### 구현 순서와 완료 기준

| 단계 | 구현 내용 | 완료 기준 |
| --- | --- | --- |
| 1 · 구현 | 기존 이벤트를 Span과 정확한 return 간선으로 변환 | Excel → Outlook → 같은 Excel을 같은 Trace로 재개 |
| 2 · 구현 | 제목 단서와 새 창 시각으로 continue/new 분리 | 흔한 월 표현만 같은 업무를 연결하지 않음 |
| 3 · 엔진 구현 | 파일 fingerprint 기반 same-artifact 간선 | fixture에서 Teams 첨부파일과 열린 Excel을 모델 없이 같은 Trace로 연결 |
| 4 · 구현 | 현재 창 기준 역방향 슬라이스 생성 | 자동 테스트에서 창 20개 중 정답 3개 선택·17개 제외 |
| 5 | 애매한 간선만 vLLM으로 판정 | 모델을 꺼도 정확한 복귀가 그대로 동작 |
| 6 | Excel 선택 위치 어댑터 | 사용자가 허용한 경우 통합 문서·시트·셀 주소만 복귀 정보에 포함 |
| 7 | UI Automation 실행 이벤트를 시작 간선으로 연결 | 실행한 첨부파일 이름과 새 Excel 문서를 같은 Trace로 연결 |
| 8 | Teams Graph 또는 Here 공유 입력 | 조직이 허용한 경우 요청 문장까지 최초 근거에 포함 |

평가 지표는 자연어 문장의 품질보다 `원인 Top-1 정확도`, `잘못 붙인 창의 비율`, `정답 근거 누락률`을 우선 사용합니다. 해커톤 시연 전에 정답이 표시된 30개 업무 시나리오를 자동 재생하고 엔진 결과를 비교합니다.

## 심사 시 보여줄 기술 장면

제품 화면을 보여준 뒤 5초 동안 역방향 추적 결과를 함께 보여줍니다.

```text
T-204  Teams ──→ Excel                 ACTIVE
                 │
                 └── Outlook           T-205 TEMP

Excel return detected → RESUME T-204
Root evidence: Teams event #18
Last work: Excel event #23
Excluded: 17 unrelated windows
```

20개의 창이 열려 있어도 Here가 최근 창 전체를 요약하지 않고, 현재 창에서 역방향으로 연결된 `T-204`만 선택하는 모습을 보여줍니다. 같은 입력에서 일반 LLM 요약은 여러 창을 섞지만, 역방향 슬라이스는 Teams 요청과 Excel만 남깁니다. 심사위원은 결과 문장과 함께 그 문장이 만들어진 경로, 분리된 알림, 제외된 창의 수, 실제 근거 ID를 한 번에 확인할 수 있습니다.

## 기술적 차별점

Here의 핵심 자산은 개인의 화면 모음이 아니라 **업무 전환 그래프**입니다. 프로그램마다 서로 다른 데이터 구조를 바꾸지 않고 데스크톱 운영체제 위에서 공통 업무 ID를 만들 수 있습니다. 같은 Trace는 사용자의 복귀 안내에 사용되고, 이후에는 사내 AI 에이전트가 다음 작업을 이어받는 안전한 입력으로 사용할 수 있습니다.
