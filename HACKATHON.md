# Here — SK 그룹 해커톤 제출 메모

- 제품 페이지: https://stpcoder.github.io/here-context-recall/
- 이미지 사용법: https://stpcoder.github.io/here-context-recall/manual/

## 한 줄

**업무가 끊긴 뒤, 시작된 요청과 멈춘 작업 대상, 지금 이어갈 한 단계를 돌려주는 버튼.**

## 문제

직장인은 파일·메신저·메일·회의 알림 사이를 계속 오갑니다. 비용이 큰 순간은 다시 현재 창으로 돌아와 “내가 이걸 왜 열었지?”라고 멈추는 몇 초입니다.

## 해결

Here는 사용자가 허용한 뒤 실제 포그라운드 창 전환을 최근 10분만 로컬 메모리에 보관합니다. `Ctrl+Shift+Space` 또는 플로팅 버블을 누르면 현재 창으로 이어진 근거를 `시작된 요청 → 실제 이동 → 멈춘 작업 대상 → 다음 한 단계`로 정리합니다. 퇴근 직전 `Ctrl+Shift+M`을 누르면 그 지점만 암호화해 저장하고, 다음 날 첫 복원에서 그대로 돌아옵니다.

- 누가 무엇을 요청했는지 보여주는 시작점
- 원래 창 → 방해 앱들 → 현재 창으로 이어진 실제 이동과 근거 ID
- 다시 시작할 작업 대상과 관측 범위를 넘지 않는 다음 행동 한 줄
- 선택 시 사내 vLLM/OpenAI-compatible endpoint 또는 gcloud 기반 Vertex Gemini 3.5 Flash가 같은 근거를 자연어로 요약
- 사용자가 켠 경우에만 복원 순간의 활성 창 한 장을 VLM 보조 맥락으로 사용

핵심은 “기억해 주는 AI”가 아니라, **지금 열린 창에 온 이유를 한 번에 되찾는 인터페이스**입니다.

## 90초 라이브 데모 — 실제 앱만 사용

사전 준비: Windows에서 Here를 실행하고 캡처 동의를 켭니다. 메모장에 `분기 리포트 확인` 같은 무해한 제목의 문서를 두 개 준비합니다. 실제 업무 문서나 민감한 메신저는 사용하지 않습니다.

**0–10초**  
“파일로 돌아왔는데, 왜 열었는지 순간 비는 경험이 있습니다.” Here의 작은 플로팅 버블과 `Ctrl+Shift+Space`를 보여줍니다.

**10–35초**  
실제 메모장 문서 A를 열고, 브라우저나 다른 메모장 문서로 잠시 전환한 뒤, 다시 A로 돌아옵니다. 이는 스크립트된 UI가 아니라 OS의 실제 활성 창 전환입니다.

**35–55초**  
현재 A에서 `Ctrl+Shift+Space`를 누릅니다. Here 패널이 시작된 요청, 실제 이동, 다시 시작할 작업 대상, 다음 한 단계를 한 화면에 보여줍니다.
“창 목록을 보여주는 것이 아닙니다. 이 근거를 읽는 즉시 다음 행동으로 돌아갑니다.”

**55–70초**
`Ctrl+Shift+M`으로 “여기 기억”을 실행합니다. 창 이미지를 켠 데모라면 Here 패널이 잠깐 숨고 원래 업무 창만 캡처됩니다. 체크포인트는 OS 암호화 저장이며 자동 타임라인 전체를 저장하지 않습니다.

**70–84초**
Here를 재시작한 뒤 `Ctrl+Shift+Space`를 누릅니다. 최근 ring buffer가 비어 있어도 저장된 지점·근거·다음 행동이 즉시 나타납니다. 이어서 Vertex AI 설정의 `gemini-3.5-flash` 연결 상태를 보여줍니다.

**84–90초**
“모든 업무를 감시하는 도구가 아닙니다. 지금 돌아온 창의 맥락만, 짧고 검증 가능하게. Here.”

## 신뢰 설계

| 구분 | Here의 실제 범위 |
| --- | --- |
| 캡처 | 활성 앱 이름, 창 제목, 프로세스, 창 경계, 전환 시각 |
| 미수집 | 키·클릭·클립보드·파일 내용·셀 값·URL·상시 스크린샷 |
| 이미지 | 기본 꺼짐. 사용자가 켜고 복원/기억을 직접 실행한 순간의 활성 창 한 장만 사용 |
| 자동 저장 | 최근 10분 기본값의 프로세스 메모리. 종료/지우기 시 제거 |
| 명시적 저장 | 선택된 근거와 선택적 이미지. OS 암호화, 최대 12개·7일 |
| 제어 | 명시적 동의, pause/resume, 보존 시간, 앱 제외, 기록 지우기 |
| 모델 | 선택 사항. Vertex Gemini VLM 또는 OAI/vLLM. 근거 ID 검증 후 요약하며 실패 시 로컬 체인 유지 |

제목 캡처는 사용자가 앱 안에서 명시적으로 동의한 뒤에만 시작되며, 비밀번호 관리자는 기본 제외합니다. 사용자는 설정에서 민감 앱을 더 제외할 수 있습니다. Windows에서는 일반 포그라운드 창 metadata에 별도 OS 권한 팝업이 없으므로 앱 내 동의가 중요합니다. 관리자 권한 또는 보호된 창은 관측되지 않을 수 있습니다.

## 구현 가능성

- Windows-first Electron 앱: 실제 foreground window reader, global shortcut, always-on-top bubble, tray
- 결정적 causal engine: `A → non-A → A`가 관측된 경우에만 interruption/return 판정
- Enterprise endpoint: Base URL + Model ID + Bearer token으로 실제 `/chat/completions`와 Here evidence JSON 계약을 검증하며, token은 OS 보호 저장소에 암호화
- Vertex QA: 로컬 Mac 품질 검증용. `gcloud` ADC/로그인과 현재 project로 `gemini-3.5-flash:generateContent`를 호출하며 별도 API key는 없음
- Long-gap return: 사용자가 만든 체크포인트만 `safeStorage`로 전체 암호화하고 재시작 뒤 복원
- 보안 경계: renderer에는 Node 권한·키·직접 네트워크 권한 없음
- 배포: `main` push마다 GitHub Actions가 Windows NSIS/portable와 macOS DMG를 빌드하고 고정 Release URL 갱신

## 제출용 문구

### Title

Here — Why was I here?

### Tagline

잊어도, 일은 끊기지 않게.

### Description

Here는 interruption 뒤 현재 창으로 돌아왔을 때, 사용자가 허용한 최근 활성 창 전환으로 시작된 요청, 실제 이동, 작업 대상과 다음 한 단계를 복원하는 Windows-first 데스크톱 유틸리티입니다. `Ctrl+Shift+M`으로 퇴근 전 지점을 암호화해 남기고 다음 날 돌아올 수 있습니다. gcloud 기반 Vertex Gemini VLM 또는 사내 vLLM을 선택적으로 연결하며, 백그라운드에서는 파일 본문·화면·키 입력 없이 최소 metadata만 다룹니다.

## 심사 시 정직하게 말할 한계

창 제목만으로 사용자의 진짜 의도, 파일 내용, 다음 작업을 확정할 수는 없습니다. Here는 관측된 전환과 사용자가 선택적으로 허용한 한 장의 이미지 범위만 제시합니다. 클릭/키 입력/문서 본문/URL을 수집하지 않으므로 자동 문서 편집이나 셀 이동 기능은 이 제출 범위에 포함하지 않습니다.
