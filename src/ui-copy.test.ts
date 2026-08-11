import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const userFacingFiles = [
  "src/App.tsx",
  "site/index.html",
  "site/manual/index.html",
  "README.md",
];

const unfamiliarPhrases = [
  "창 흐름 기록",
  "맥락 복원",
  "나중에 이어보기",
  "흐름을 다시 잇는 중",
  "복원·기억",
  "잠깐의 이탈",
  "원인 체인",
  "Work AI",
  "VLM 연결 테스트",
  "QA 테스트",
  "Base URL",
  "Model ID",
  "Bearer token",
];

describe("user-facing terminology", () => {
  it.each(userFacingFiles)("uses plain task-oriented words in %s", (file) => {
    const copy = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const phrase of unfamiliarPhrases) expect(copy).not.toContain(phrase);
  });

  it("uses the same three action names across the product UI", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    expect(app).toContain("최근 사용한 창 기록");
    expect(app).toContain("하던 일 찾기");
    expect(app).toContain("작업 저장");
  });
});
