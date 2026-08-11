import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityMonitor, type NativeWindow } from "./activity-monitor";
import { explainCausalChain } from "./causal-engine";
import { LlmService, type Evidence } from "./llm-service";

function window(
  id: number,
  app: string,
  title: string,
): NativeWindow {
  return {
    id,
    title,
    owner: {
      name: app,
      processId: 1_000 + id,
      path: `C:\\Program Files\\${app}\\${app}.exe`,
    },
    contentBounds: { x: 40, y: 60, width: 1_100, height: 720 },
  };
}

afterEach(() => vi.useRealTimers());

describe("Windows context pipeline", () => {
  it("captures a work path, selects the exact return chain, and sends it once", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-12T00:00:00Z") });
    let active = window(1, "Microsoft Teams", "Q3 예산 숫자 확인 요청");
    const reader = { activeWindow: vi.fn(async () => active) };
    const monitor = new ActivityMonitor(
      { platform: "win32", pollIntervalMs: 500, hereProcessId: 999 },
      reader,
    );
    await monitor.start();
    active = window(2, "File Explorer", "재무팀 > 3분기 보고");
    await vi.advanceTimersByTimeAsync(500);
    active = window(3, "Microsoft Excel", "Q3_예산검토.xlsx");
    await vi.advanceTimersByTimeAsync(500);
    active = window(4, "Microsoft Outlook", "오후 회의 일정");
    await vi.advanceTimersByTimeAsync(500);
    active = window(3, "Microsoft Excel", "Q3_예산검토.xlsx");
    await vi.advanceTimersByTimeAsync(500);

    const events = monitor.recent();
    const current = monitor.current();
    const explanation = explainCausalChain({ events, current });
    expect(explanation).toMatchObject({
      interrupted: true,
      confidence: "high",
      boundary: { reason: "return-chain" },
    });
    expect(explanation.chain.map((step) => step.label)).toEqual([
      "Microsoft Teams — Q3 예산 숫자 확인 요청",
      "File Explorer — 재무팀 > 3분기 보고",
      "Microsoft Excel — Q3_예산검토.xlsx",
      "Microsoft Outlook — 오후 회의 일정",
      "Microsoft Excel — Q3_예산검토.xlsx",
    ]);

    const selected = new Set(explanation.evidenceIds);
    const evidence: Evidence[] = events
      .filter((event) => event.kind === "window-focus" && selected.has(event.id))
      .map((event) => ({
        id: event.id,
        at: new Date(event.timestamp).toISOString(),
        app: event.appName!,
        title: event.title!,
        kind: "focus",
      }));
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const input = JSON.parse(request.messages[1].content) as {
        evidence: Evidence[];
      };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "Q3 예산 확인 흐름입니다.",
                  target: "Q3_예산검토.xlsx",
                  evidenceIds: input.evidence.map(({ id }) => id),
                  nextAction: "비용 증감 열 확인",
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const model = new LlmService({
      getConfiguration: () => ({
        endpoint: "http://127.0.0.1:8000/v1",
        model: "internal-model",
      }),
      fetch,
    });
    const currentInput = {
      id: current!.id,
      app: current!.appName,
      title: current!.title,
    };
    await expect(model.reconstruct(evidence, currentInput)).resolves.toMatchObject({
      source: "model",
      target: "Q3_예산검토.xlsx",
    });
    await model.reconstruct(evidence, currentInput);
    expect(fetch).toHaveBeenCalledTimes(1);
    const sent = String(fetch.mock.calls[0][1]?.body);
    expect(sent).not.toContain("processId");
    expect(sent).not.toContain("bounds");
    expect(sent).not.toContain("Program Files");
    monitor.stop();
  });
});
