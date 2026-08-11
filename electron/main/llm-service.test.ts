import { describe, expect, it, vi } from "vitest";
import { LlmService, validateEndpoint } from "./llm-service";

const evidence = [
  {
    id: "e1",
    at: "2026-08-11T14:31:00Z",
    app: "Slack",
    title: "Sample A question",
    kind: "message" as const,
  },
  {
    id: "e2",
    at: "2026-08-11T14:33:00Z",
    app: "Excel",
    title: "result.xlsx",
    kind: "file" as const,
  },
];
const config = {
  endpoint: "http://127.0.0.1:8000/v1",
  model: "qwen",
  apiKey: "secret",
};

function reconstructionResponse(
  evidenceIds: string[],
  options: {
    contentAsParts?: boolean;
    prefix?: string;
    nextAction?: string | null;
    extra?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): Response {
  const value = `${options.prefix ?? ""}${JSON.stringify({
    summary: "관측된 흐름을 복원했습니다.",
    target: "result.xlsx",
    evidenceIds,
    nextAction:
      "nextAction" in options ? options.nextAction : "작업을 이어가세요.",
    ...options.extra,
  })}`;
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: options.contentAsParts
              ? [{ type: "text", text: value }]
              : value,
          },
        },
      ],
    }),
    { status: 200, headers: options.headers },
  );
}

describe("LlmService", () => {
  it("verifies the selected OpenAI-compatible model with a real chat call", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reconstructionResponse(["here-connection-check"]))
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "qwen" }] }), {
          status: 200,
        }),
      );
    const service = new LlmService({ getConfiguration: () => config, fetch });
    await expect(service.testConnection()).resolves.toMatchObject({
      ok: true,
      models: ["qwen"],
      selectedModel: "qwen",
      chatCompletionVerified: true,
      reconstructionVerified: true,
      structuredOutputMode: "json-schema",
      modelsEndpointAvailable: true,
    });
    expect(fetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8000/v1/chat/completions",
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      model: "qwen",
      max_tokens: 256,
      response_format: { type: "json_schema" },
    });
    expect(fetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer secret",
    });
    expect(fetch.mock.calls[1][0]).toBe("http://127.0.0.1:8000/v1/models");
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
  });

  it("accepts a chat-only internal gateway without a models endpoint", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reconstructionResponse(["here-connection-check"]))
      .mockResolvedValueOnce(new Response("not exposed", { status: 404 }));
    await expect(
      new LlmService({ getConfiguration: () => config, fetch }).testConnection(),
    ).resolves.toMatchObject({
      ok: true,
      models: ["qwen"],
      selectedModel: "qwen",
      chatCompletionVerified: true,
      reconstructionVerified: true,
      modelsEndpointAvailable: false,
    });
  });

  it("reports an explicit text-only connection when the VLM probe is rejected", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "multimodal input unsupported" } }),
          { status: 415 },
        ),
      )
      .mockResolvedValueOnce(reconstructionResponse(["here-connection-check"]))
      .mockResolvedValueOnce(new Response("hidden", { status: 404 }));
    const result = await new LlmService({
      getConfiguration: () => config,
      fetch,
    }).testConnection(config, {
      visionRequested: true,
      vision: { mimeType: "image/png", dataBase64: "aGVyZQ==" },
    });
    expect(result).toMatchObject({
      ok: true,
      reconstructionVerified: true,
      visionRequested: true,
      visionVerified: false,
      structuredOutputMode: "json-schema",
    });
    expect(result.warning).toContain("앱과 창 제목만");
  });

  it("falls back from JSON Schema to JSON object and validates evidence IDs", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unsupported", { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "Asked then opened workbook",
                    target: "result.xlsx",
                    evidenceIds: ["e1", "e2"],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const result = await new LlmService({
      getConfiguration: () => config,
      fetch,
    }).reconstruct(evidence);
    expect(result.source).toBe("model");
    expect(JSON.parse(fetch.mock.calls[0][1].body).response_format.type).toBe(
      "json_schema",
    );
    expect(JSON.parse(fetch.mock.calls[1][1].body).response_format.type).toBe(
      "json_object",
    );
  });

  it("remembers the compatible output mode for the next recall", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unsupported", { status: 400 }))
      .mockResolvedValueOnce(reconstructionResponse(["e1", "e2"]))
      .mockResolvedValueOnce(reconstructionResponse(["e1", "e2"]));
    const service = new LlmService({ getConfiguration: () => config, fetch });
    await service.reconstruct(evidence);
    await service.reconstruct(
      evidence.map((item, index) =>
        index === 1 ? { ...item, title: "result-v2.xlsx" } : item,
      ),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetch.mock.calls[2][1].body).response_format.type).toBe(
      "json_object",
    );
  });

  it("caches an identical reconstruction instead of spending another model call", async () => {
    const fetch = vi.fn().mockResolvedValue(reconstructionResponse(["e1", "e2"]));
    const service = new LlmService({ getConfiguration: () => config, fetch });
    const first = await service.reconstruct(evidence);
    const second = await service.reconstruct(evidence);
    expect(first.source).toBe("model");
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.runtimeStats()).toMatchObject({
      requestsInWindow: 1,
      cacheHits: 1,
      inflightHits: 0,
    });
  });

  it("coalesces concurrent recalls for the same evidence", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const service = new LlmService({ getConfiguration: () => config, fetch });
    const first = service.reconstruct(evidence);
    const second = service.reconstruct(evidence);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    resolveFetch?.(reconstructionResponse(["e1", "e2"]));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(service.runtimeStats().inflightHits).toBe(1);
  });

  it("falls back locally when the one-minute request budget is exhausted", async () => {
    const fetch = vi.fn().mockResolvedValue(reconstructionResponse(["e1", "e2"]));
    const service = new LlmService({
      getConfiguration: () => config,
      fetch,
      runtimeBudget: {
        maxRequestsPerMinute: 1,
        maxEstimatedTokensPerMinute: 10_000,
        cacheTtlMs: 120_000,
      },
    });
    expect((await service.reconstruct(evidence)).source).toBe("model");
    const changed = evidence.map((item, index) =>
      index === 1 ? { ...item, title: "another-result.xlsx" } : item,
    );
    expect((await service.reconstruct(changed)).source).toBe("fallback");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.runtimeStats()).toMatchObject({
      requestsInWindow: 1,
      budgetFallbacks: 1,
    });
  });

  it("recovers from successful but malformed responses and parses text parts", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "not json" } }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "still not json" } }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        reconstructionResponse(["e1", "e2"], {
          contentAsParts: true,
          prefix: "결과입니다.\n```json\n",
          nextAction: null,
          extra: { confidence: 0.91 },
        }),
      );
    const result = await new LlmService({
      getConfiguration: () => config,
      fetch,
    }).reconstruct(evidence);
    expect(result).toMatchObject({
      source: "model",
      evidenceIds: ["e1", "e2"],
      nextAction: undefined,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetch.mock.calls[2][1].body).response_format).toBeUndefined();
  });

  it("falls back to text evidence when an endpoint rejects image input", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "image input is not supported" } }),
          { status: 415 },
        ),
      )
      .mockResolvedValueOnce(reconstructionResponse(["e1", "e2"]));
    const result = await new LlmService({
      getConfiguration: () => config,
      fetch,
    }).reconstruct(evidence, undefined, undefined, {
      mimeType: "image/png",
      dataBase64: "aGVyZQ==",
    });
    expect(result.source).toBe("model");
    expect(
      JSON.parse(fetch.mock.calls[0][1].body).messages[1].content,
    ).toBeInstanceOf(Array);
    expect(typeof JSON.parse(fetch.mock.calls[1][1].body).messages[1].content).toBe(
      "string",
    );
  });

  it("falls back deterministically for fabricated evidence", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"summary":"x","target":"y","evidenceIds":["fake"]}',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const result = await new LlmService({
      getConfiguration: () => config,
      fetch,
    }).reconstruct(evidence);
    expect(result).toMatchObject({
      source: "fallback",
      evidenceIds: ["e1", "e2"],
    });
  });

  it("permits HTTPS and local/private HTTP only", () => {
    expect(() => validateEndpoint("https://api.example.com/v1")).not.toThrow();
    expect(() => validateEndpoint("http://192.168.1.5:8000/v1")).not.toThrow();
    expect(() => validateEndpoint("http://api.example.com/v1")).toThrow(
      /HTTPS/,
    );
    expect(() =>
      validateEndpoint("https://api.example.com/v1?token=secret"),
    ).toThrow(/쿼리/);
  });

  it("accepts a pasted full chat-completions URL as a Base URL", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reconstructionResponse(["here-connection-check"]))
      .mockResolvedValueOnce(new Response("hidden", { status: 404 }));
    await new LlmService({
      getConfiguration: () => ({
        ...config,
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
      }),
      fetch,
    }).testConnection();
    expect(fetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8000/v1/chat/completions",
    );
  });

  it("returns a sanitized vLLM error without echoing credentials", async () => {
    const apiKey = "opaque-company-token-123";
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: `invalid token ${apiKey}, Bearer secret-token and sk-1234567890abcdef`,
          },
        }),
        { status: 401, headers: { "x-request-id": "req-vllm-42" } },
      ),
    );
    const result = await new LlmService({
      getConfiguration: () => ({ ...config, apiKey }),
      fetch,
    }).testConnection();
    expect(result).toMatchObject({ ok: false, reconstructionVerified: false });
    expect(result.error).toContain("401");
    expect(result.error).toContain("req-vllm-42");
    expect(result.error).not.toContain(apiKey);
    expect(result.error).not.toContain("secret-token");
    expect(result.error).not.toContain("sk-1234567890abcdef");
  });

  it("aborts a stalled model request and returns an actionable timeout", async () => {
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const result = await new LlmService({
      getConfiguration: () => config,
      fetch,
      timeoutMs: 5,
    }).testConnection();
    expect(result).toMatchObject({ ok: false, reconstructionVerified: false });
    expect(result.error).toContain("응답 제한 시간");
  });

  it("rejects oversized model responses and uses the local result", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: { "content-length": "1000001" },
        }),
      );
    const result = await new LlmService({
      getConfiguration: () => config,
      fetch,
    }).reconstruct(evidence);
    expect(result.source).toBe("fallback");
  });

  it("uses gcloud auth and the configured Vertex Gemini model", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "HERE_OK" }] } }],
        }),
        { status: 200 },
      ),
    );
    const service = new LlmService({
      getConfiguration: () => ({
        modelProvider: "vertex-gcloud",
        endpoint: "http://127.0.0.1:8000/v1",
        model: "gemini-3.5-flash",
        vertexProject: "",
        vertexLocation: "global",
      }),
      getVertexAccessToken: async () => "access-token",
      getVertexProject: async () => "project-12345",
      fetch,
    });

    await expect(service.testConnection()).resolves.toMatchObject({
      ok: true,
      models: ["gemini-3.5-flash"],
      selectedModel: "gemini-3.5-flash",
      chatCompletionVerified: true,
    });
    expect(fetch.mock.calls[0][0]).toBe(
      "https://aiplatform.googleapis.com/v1/projects/project-12345/locations/global/publishers/google/models/gemini-3.5-flash:generateContent",
    );
    expect(fetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer access-token",
    });
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
  });

  it("sends an opt-in window image to Vertex and accepts only observed evidence IDs", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: "질문에서 결과 파일로 이동한 흐름입니다.",
                      target: "result.xlsx",
                      evidenceIds: ["e1", "e2"],
                      nextAction: "Sample A 값을 확인하세요.",
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const service = new LlmService({
      getConfiguration: () => ({
        modelProvider: "vertex-gcloud",
        endpoint: "http://127.0.0.1:8000/v1",
        model: "gemini-3.5-flash",
        vertexProject: "project-12345",
        vertexLocation: "global",
      }),
      getVertexAccessToken: async () => "access-token",
      getVertexProject: async () => "unused-project",
      fetch,
    });

    await expect(
      service.reconstruct(evidence, undefined, undefined, {
        mimeType: "image/png",
        dataBase64: "aGVyZQ==",
      }),
    ).resolves.toMatchObject({
      source: "model",
      target: "result.xlsx",
      evidenceIds: ["e1", "e2"],
    });
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload.contents[0].parts[1]).toEqual({
      inlineData: { mimeType: "image/png", data: "aGVyZQ==" },
    });
    expect(payload.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 128 },
    });
  });
});
