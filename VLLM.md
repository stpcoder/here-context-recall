# 사내 vLLM / OpenAI-compatible 연결 가이드

Here의 실제 업무 모델 경로는 Vertex가 아니라 OpenAI-compatible
`/v1/chat/completions`입니다. Vertex는 로컬 Mac QA용으로만 남아 있습니다.

## 서버 계약

필수 입력은 세 가지입니다.

- Base URL: `https://llm.company.internal/v1`
- Model ID: vLLM이 serve한 정확한 모델 이름
- Bearer token: `vllm serve --api-key` 또는 사내 gateway가 발급한 token

Here는 Base URL 뒤에 `/chat/completions`와 선택적인 `/models`를 붙입니다.
사용자가 실수로 전체 `/v1/chat/completions` 주소를 붙여 넣어도 Base URL로
정규화합니다. 원격 HTTP는 허용하지 않으며 HTTPS 또는 localhost/private IP의
HTTP만 허용합니다.

vLLM의 Chat Completions에는 해당 모델의 chat template가 필요합니다. 모델에
기본 template가 없으면 서버 실행 시 `--chat-template`을 지정해야 합니다.
[vLLM 공식 OpenAI-compatible server 문서](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/)를 참고하세요.

## 앱의 “업무 모델 복원 테스트”가 확인하는 것

단순한 `hello` 호출이 아닙니다. 실제 Here 복원과 같은 계약을 검사합니다.

1. 선택한 Model ID와 Bearer token으로 `POST /chat/completions`
2. 관측된 evidence ID만 허용하는 JSON Schema 출력
3. JSON Schema 미지원 시 `json_object`, 그다음 prompt-only JSON으로 전환
4. 결과의 `summary`, `target`, `evidenceIds`, `nextAction` 스키마 검증
5. “복원 순간의 창 한 장 보기”가 켜져 있으면 사용자 화면 대신 내장 Here
   아이콘으로 VLM 입력을 안전하게 검사
6. 이미지 입력이 거부되면 text-only 복원이 실제로 성공하는지 재검사
7. `/models`는 5초 안에 응답할 때만 참고하며 없어도 연결 성공

성공 메시지에는 사용한 출력 모드와 `VLM 이미지 확인` 또는
`text-only 자동 전환`이 표시됩니다. 테스트 성공 뒤 **저장**을 눌러야 Base
URL과 Model ID, token이 적용됩니다.

## 런타임 동작

- 요청은 `stream: false`, `temperature: 0`, 최대 320 output tokens로 보냅니다.
- 전체 모델 요청 제한 시간은 30초입니다.
- 동일 근거는 2분간 재사용하고 동시에 눌린 요청은 하나로 합칩니다.
- 자동 복원은 분당 최대 4 HTTP 요청, 보수적으로 추정한 12,000 TPM 안에서만
  실행합니다. 호환성 재시도도 이 예산에 포함되며 초과 시 로컬 결과를 유지합니다.
- reasoning 모델의 `reasoning_content`, 문자열 응답, text content parts를 모두
  처리합니다.
- 코드 펜스·`<think>` 블록·JSON 앞뒤 설명이 있어도 안전하게 JSON 객체를
  추출합니다.
- 잘못된 evidence ID는 거부하고 즉시 관측 기반 로컬 결과를 유지합니다.
- VLM이 413/415 또는 명시적인 multimodal 오류를 반환하면 이후 요청은
  text-only로 기억해 불필요한 실패 호출을 반복하지 않습니다.

## 사내 환경 점검표

- 사내 TLS 인증서가 Windows/macOS의 OS 신뢰 저장소에 설치되어 있어야 합니다.
- gateway가 `Authorization: Bearer …`를 upstream으로 전달해야 합니다.
- gateway가 JSON body와 `response_format`을 제거하거나 변형하지 않아야 합니다.
- Model ID는 `/models`의 표시 이름이 아니라 실제 serve alias와 정확히 같아야
  합니다.
- text-generation 모델은 chat template가 있어야 합니다.
- 화면 이미지 기능을 쓰려면 선택 모델 자체가 multimodal이어야 합니다.
- 모델 서버가 `generation_config.json`의 sampling 기본값을 적용하는 경우
  운영자가 vLLM의 `--generation-config vllm` 사용 여부를 검토하세요.

Bearer token은 renderer나 설정 JSON에 평문으로 저장하지 않습니다. Electron
main process에서만 사용하고 OS `safeStorage`로 암호화합니다. Base URL/Model
ID/token 교체는 하나의 원자적 파일 교체로 저장하므로 OS 암호화가 실패해도 새
endpoint와 이전 token이 섞여 남지 않습니다. 서버 오류 문구에 token이 포함돼도
사용자에게 보여주기 전에 제거합니다.
