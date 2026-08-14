import assert from "node:assert/strict";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.DEMO_BASE_URL || "http://127.0.0.1:4173";
const outputPath = process.env.DEMO_RAW_OUTPUT || "qa/video/here-sk-ai-hackathon.webm";
const viewport = { width: 1440, height: 900 };
const pause = (page, milliseconds) => page.waitForTimeout(milliseconds);

function demoUrl(fast = false) {
  return baseUrl + "/?demo=1" + (fast ? "&fast=1" : "");
}

async function installCursor(page) {
  await page.evaluate(() => {
    document.querySelector("[data-demo-cursor-style]")?.remove();
    document.querySelector("#demo-cursor")?.remove();

    const style = document.createElement("style");
    style.dataset.demoCursorStyle = "true";
    style.textContent = `
      html, body { overflow: hidden !important; }
      #demo-cursor {
        position: fixed;
        left: 1120px;
        top: 760px;
        width: 31px;
        height: 36px;
        z-index: 2147483647;
        pointer-events: none;
        filter: drop-shadow(0 3px 6px rgba(8, 14, 30, .42));
        transition-property: left, top;
        transition-timing-function: cubic-bezier(.22, 1, .36, 1);
      }
      #demo-cursor svg { display: block; width: 100%; height: 100%; }
      .demo-click-ring {
        position: fixed;
        width: 20px;
        height: 20px;
        margin: -10px 0 0 -10px;
        border: 3px solid #ff6b35;
        border-radius: 50%;
        z-index: 2147483646;
        pointer-events: none;
        animation: demoPulse 720ms cubic-bezier(.16, 1, .3, 1) forwards;
      }
      @keyframes demoPulse {
        from { opacity: 1; transform: scale(.45); }
        to { opacity: 0; transform: scale(3.2); }
      }
    `;
    document.head.appendChild(style);

    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.innerHTML = '<svg viewBox="0 0 34 38" aria-hidden="true"><path d="M4 3.2 28 22.5l-11.1 1.3 6.1 9.5-5.7 3.1-5.9-9.7-6.6 8.8L4 3.2Z" fill="#fff" stroke="#111827" stroke-width="2.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cursor);
  });
}

async function moveCursorTo(page, locator, duration = 950, position = { x: 0.5, y: 0.5 }) {
  await locator.scrollIntoViewIfNeeded();
  await pause(page, 240);
  const box = await locator.boundingBox();
  assert(box, "Demo cursor target is not visible");
  const x = box.x + box.width * position.x;
  const y = box.y + box.height * position.y;

  await page.evaluate(({ x, y, duration }) => {
    const cursor = document.querySelector("#demo-cursor");
    if (!(cursor instanceof HTMLElement)) throw new Error("Demo cursor is missing");
    cursor.style.transitionDuration = duration + "ms";
    cursor.style.left = x - 4 + "px";
    cursor.style.top = y - 4 + "px";
  }, { x, y, duration });

  await page.mouse.move(x, y, { steps: 30 });
  await pause(page, duration + 120);
  return { x, y };
}

async function clickWithCursor(page, locator, options = {}) {
  const {
    moveDuration = 950,
    holdAfter = 720,
    position = { x: 0.5, y: 0.5 },
  } = options;
  const point = await moveCursorTo(page, locator, moveDuration, position);
  await page.evaluate(({ x, y }) => {
    const ring = document.createElement("div");
    ring.className = "demo-click-ring";
    ring.style.left = x + "px";
    ring.style.top = y + "px";
    document.body.appendChild(ring);
    window.setTimeout(() => ring.remove(), 760);
  }, point);
  await locator.click();
  await pause(page, holdAfter);
}

async function verifyScenario(browser) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(demoUrl(true), { waitUntil: "networkidle" });
  await page.getByLabel("Here 인트로").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Teams 알림 열기" }).waitFor();
  await page.screenshot({ path: "qa/screenshots/demo-01-interruption.png" });

  await page.getByRole("button", { name: "Teams 알림 열기" }).click();
  await page.getByLabel("Microsoft Teams 재무팀 대화").waitFor();
  await page.getByRole("textbox", { name: "답장 입력" }).fill("네, 6월 실질 인건비 검토해서 공유드릴게요.");
  await page.getByRole("button", { name: "답장 보내기" }).click();
  await page.getByText("네, 6월 실질 인건비 검토해서 공유드릴게요.").waitFor();
  await page.screenshot({ path: "qa/screenshots/demo-02-teams.png" });

  await page.getByRole("button", { name: "6월 인건비 마감 Excel 파일 열기" }).click();
  await page.getByRole("button", { name: "Outlook 알림 열기" }).waitFor();
  await page.getByRole("button", { name: "Outlook 알림 열기" }).click();
  await page.getByLabel("Microsoft Outlook 받은 편지함").waitFor();
  await page.screenshot({ path: "qa/screenshots/demo-03-outlook.png" });

  await page.keyboard.down("Alt");
  await page.keyboard.press("Tab");
  await page.getByRole("dialog", { name: "열린 창 선택" }).waitFor();
  await page.screenshot({ path: "qa/screenshots/demo-03-alt-tab.png" });
  await page.keyboard.up("Alt");
  await page.getByRole("button", { name: "왜 이 창을 열었는지 확인" }).waitFor();
  await page.getByRole("button", { name: "왜 이 창을 열었는지 확인" }).click();
  await page.getByRole("dialog", { name: "Here가 하던 일을 찾고 있습니다" }).waitFor();
  await page.screenshot({ path: "qa/screenshots/demo-04-loading.png" });
  await page.getByRole("dialog", { name: "Here 업무 인수인계" }).waitFor();
  await page.getByText("6월 실질 인건비를 검토하려고 이 파일을 열었어요.").waitFor();
  await page.screenshot({ path: "qa/screenshots/demo-04-here.png" });

  await page.getByRole("button", { name: "검토하던 곳으로 이동" }).click();
  await page.getByRole("status").waitFor();
  await page.locator('[data-cell="D6"].is-selected').waitFor();
  await page.screenshot({ path: "qa/screenshots/demo-05-success.png" });
  await page.getByLabel("Here 아웃트로").waitFor();
  await page.screenshot({ path: "qa/screenshots/demo-06-outro.png" });

  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log("Verified the complete demo flow");
}

async function recordScenario(browser) {
  await mkdir("qa/video/raw", { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: "qa/video/raw", size: viewport },
  });
  const page = await context.newPage();
  const recordingStartedAt = Date.now();
  const mark = (label) => console.log(`[timeline ${((Date.now() - recordingStartedAt) / 1000).toFixed(2)}] ${label}`);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(demoUrl(false), { waitUntil: "networkidle" });
  await installCursor(page);
  await page.getByLabel("Here 인트로").waitFor();
  mark("intro visible");
  await page.getByLabel("Here 인트로").waitFor({ state: "hidden" });
  mark("intro hidden");

  const teamsNotice = page.getByRole("button", { name: "Teams 알림 열기" });
  await teamsNotice.waitFor({ timeout: 10_000 });
  mark("teams notice visible");
  await pause(page, 2_500);
  await clickWithCursor(page, teamsNotice, { moveDuration: 1_100, holdAfter: 850 });

  await page.getByLabel("Microsoft Teams 재무팀 대화").waitFor();
  mark("teams open");
  await pause(page, 3_000);
  const replyInput = page.getByRole("textbox", { name: "답장 입력" });
  await clickWithCursor(page, replyInput, { moveDuration: 850, holdAfter: 350 });
  await page.keyboard.type("네, 6월 실질 인건비 검토해서 공유드릴게요.", { delay: 55 });
  await pause(page, 650);
  await clickWithCursor(page, page.getByRole("button", { name: "답장 보내기" }), { moveDuration: 420, holdAfter: 650 });
  await page.getByText("네, 6월 실질 인건비 검토해서 공유드릴게요.").waitFor();
  mark("reply sent");
  await pause(page, 2_000);
  const workbook = page.getByRole("button", { name: "6월 인건비 마감 Excel 파일 열기" });
  await clickWithCursor(page, workbook, { moveDuration: 1_050, holdAfter: 850 });
  mark("excel open");

  await page.locator('[data-cell="A6"]').waitFor();
  await moveCursorTo(page, page.locator('[data-cell="A6"]'), 500);
  await moveCursorTo(page, page.locator('[data-cell="C6"]'), 220);
  await moveCursorTo(page, page.locator('[data-cell="E6"]'), 220);
  await moveCursorTo(page, page.locator('[data-cell="D6"]'), 220);

  const outlookNotice = page.getByRole("button", { name: "Outlook 알림 열기" });
  await outlookNotice.waitFor({ timeout: 10_000 });
  mark("outlook notice visible");
  await pause(page, 3_600);
  await clickWithCursor(page, outlookNotice, { moveDuration: 1_100, holdAfter: 850 });

  await page.getByLabel("Microsoft Outlook 받은 편지함").waitFor();
  mark("outlook open");
  await pause(page, 5_500);
  await page.keyboard.down("Alt");
  await page.keyboard.press("Tab");
  await page.getByRole("dialog", { name: "열린 창 선택" }).waitFor();
  mark("task switcher open");
  await pause(page, 1_150);
  await page.keyboard.press("Tab");
  await pause(page, 750);
  await page.keyboard.press("Shift+Tab");
  await pause(page, 1_000);
  await page.keyboard.up("Alt");
  await page.getByLabel("6월 인건비 마감 Excel 통합 문서").waitFor();
  mark("excel returned");

  const hereBubble = page.getByRole("button", { name: "왜 이 창을 열었는지 확인" });
  await hereBubble.waitFor({ timeout: 10_000 });
  await pause(page, 4_500);
  await clickWithCursor(page, hereBubble, { moveDuration: 950, holdAfter: 900 });

  await page.getByRole("dialog", { name: "Here가 하던 일을 찾고 있습니다" }).waitFor();
  mark("here loading");
  await page.getByRole("dialog", { name: "Here 업무 인수인계" }).waitFor();
  mark("here panel open");
  await page.screenshot({ path: "qa/screenshots/demo-04-here.png" });
  await page.mouse.move(1300, 780, { steps: 2 });
  await pause(page, 7_500);
  const continueButton = page.getByRole("button", { name: "검토하던 곳으로 이동" });
  await clickWithCursor(page, continueButton, { moveDuration: 1_000, holdAfter: 850 });

  await page.getByRole("status").waitFor();
  await page.locator('[data-cell="D6"].is-selected').waitFor();
  mark("target selected");
  await page.getByLabel("Here 아웃트로").waitFor({ timeout: 10_000 });
  mark("outro visible");
  await pause(page, 5_200);
  assert.deepEqual(pageErrors, []);

  const video = page.video();
  await context.close();
  await rm(outputPath, { force: true });
  await rename(await video.path(), outputPath);
  console.log("Recorded " + outputPath);
}

await mkdir("qa/screenshots", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});

try {
  await verifyScenario(browser);
  await recordScenario(browser);
} finally {
  await browser.close();
}
