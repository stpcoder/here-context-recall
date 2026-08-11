# Here.

> “방금 내가 왜 이 창을 열었지?”에, 최근 흐름으로 답하는 데스크톱 버튼.

Here는 모든 것을 기록하는 memory AI가 아닙니다. 사용자가 허용한 뒤 **현재 포그라운드 앱과 창 제목의 전환**만 짧게 보관하고, `Ctrl+Shift+Space` 또는 화면의 작은 버튼으로 최근 흐름을 되짚습니다.

Windows에서 먼저 쓰도록 만든 Electron 데스크톱 유틸리티입니다. 브라우저 데모나 가짜 Office/Slack 화면을 사용하지 않습니다.

## 작동 방식

1. 사용자가 캡처 동의를 켭니다.
2. Here가 약 1초 간격으로 실제 활성 창의 앱 이름, 창 제목, 프로세스, 창 경계만 읽습니다.
3. 최근 10분(설정 가능)의 전환을 메모리에만 유지합니다.
4. 전역 단축키 `Ctrl+Shift+Space` / `CommandOrControl+Shift+Space`, 트레이 메뉴, 또는 플로팅 버블에서 **왜 여기지?**를 엽니다.
5. 우선 근거 ID가 있는 결정적 체인을 즉시 보여주고, 선택한 OpenAI-compatible 모델이 있으면 같은 근거를 짧은 문장으로 정리합니다.

`A → 다른 앱들 → A`가 실제로 관측된 경우에만 “다시 돌아옴/방해”로 표시합니다. 모델은 사실을 만들 권한이 없고, 응답의 evidence ID가 관측 이벤트에 속하는지 검증합니다.

## 수집하지 않는 것

- 키 입력, 마우스 클릭, 화면 캡처, 클립보드
- 파일 본문, Excel 셀 값, 메일/메신저 내용
- 브라우저 URL, 웹 페이지 내용, 파일 경로

현재 신호는 **활성 창의 앱 이름·창 제목·프로세스·창 위치/크기**뿐이며, 제목 캡처도 명시적 동의를 켠 뒤에만 시작합니다. 비밀번호 관리자와 Windows Security는 기본 제외 대상이고, 사용자는 설정에서 민감 앱을 추가 제외할 수 있습니다.

## 개인정보와 권한

- 캡처는 기본 꺼짐이며, 앱 안에서 명시적으로 동의해야 시작됩니다.
- 기록은 프로세스 메모리의 짧은 ring buffer에만 존재하고, 기본 보존 시간은 10분입니다. 앱 종료 또는 **기록 지우기**로 사라집니다.
- API 키는 렌더러나 브라우저 저장소로 전달하지 않고, Electron 메인 프로세스에서 OS 보호 저장소(`safeStorage`: Windows DPAPI / macOS Keychain)를 사용해 암호화합니다.
- Windows는 일반 포그라운드 창 메타데이터에 별도 OS 권한 팝업이 없습니다. Here의 동의 화면이 이 동의를 대신하며, 관리자 권한 앱 등 OS가 읽지 못하는 창은 관측하지 못할 수 있습니다.
- macOS는 활성 창 제목을 읽기 위해 접근성/화면 기록 권한을 요구할 수 있습니다. 권한을 거부하면 캡처는 조용히 실패하며 앱은 계속 동작합니다.

## OpenAI-compatible / vLLM

설정 화면에서 Endpoint, 모델 ID, API key(선택)를 넣습니다.

- Endpoint 예: `http://127.0.0.1:8000/v1`, 사내 HTTPS gateway
- 연결 확인: `GET {endpoint}/models`
- 복원 요청: `POST {endpoint}/chat/completions`

`response_format`을 지원하지 않는 호환 서버에는 일반 JSON 요청으로 한 번 재시도합니다. Endpoint가 비어 있거나 모델 호출에 실패해도 결정적 로컬 체인은 남습니다. 사내 데이터 정책에 따라 제목 metadata를 모델로 보내도 되는지 먼저 확인하세요.

## 개발

Node.js 22 LTS를 권장합니다.

```bash
npm ci
npm run dev
```

개발 앱을 열고 Settings에서 캡처 동의를 켠 뒤, 실제로 앱을 몇 번 전환해 보세요. `Ctrl+Shift+Space`를 누르면 최근 체인을 확인할 수 있습니다.

```bash
npm run typecheck
npm test
npm run build
```

`build`는 타입 검사, 단위 테스트, Electron 번들을 수행합니다. 설치 파일은 만들지 않습니다.

## 패키징

```bash
# Windows x64: NSIS 설치본 + portable .exe
npm run dist:win

# Windows x64 portable .exe만
npm run dist:win:portable

# 현재 macOS arm64 DMG
npm run dist:mac
```

결과물은 `release/<version>/`에 생성됩니다. Windows 실행 검증과 NSIS 설치본은 GitHub Actions의 Windows runner에서 수행하는 것을 기준으로 합니다. macOS 호스트에서 Windows 동작을 검증했다고 주장하지 않습니다.

`.github/workflows/build-desktop.yml`은 태그(`v*`) 또는 수동 실행 시 Windows NSIS/portable와 macOS DMG를 각각 artifact로 업로드합니다. Windows 코드 서명은 `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` secrets가 있을 때만 적용됩니다. 현재 macOS 구성은 배포용 Developer ID 서명·notarization 없이 ad-hoc 서명만 적용되므로 Gatekeeper 경고가 날 수 있습니다.

## 알려진 한계

- 파일을 연 이유나 “찾던 값”은 창 제목만으로 확정할 수 없습니다. Here는 관측한 전환의 순서만 말합니다.
- 클릭·키보드·문서 내용·URL·파일 열람 이벤트는 의도적으로 수집하지 않아, 해당 수준의 복원이나 자동 작업은 제공하지 않습니다.
- Windows에서는 일반 데스크톱 창을 대상으로 하며, UAC/보호된 창/권한이 더 높은 프로세스는 빠질 수 있습니다.
- macOS 지원은 보조적이며 권한 설정과 unsigned 배포 제약이 있습니다.

## 구조

```text
Native foreground-window reader
  → in-memory activity monitor (10 min)
  → deterministic causal chain
  → optional OAI/vLLM reconstruction
  → secure preload bridge
  → floating bubble / recall panel / tray
```

Electron renderer에는 Node 권한이 없고(`contextIsolation`, `sandbox`, `nodeIntegration: false`), 네트워크 호출과 키 복호화는 메인 프로세스에서만 수행합니다.
