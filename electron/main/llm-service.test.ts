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

describe("LlmService", () => {
  it("tests OpenAI-compatible models endpoint", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "qwen" }] }), {
          status: 200,
        }),
      );
    const service = new LlmService({ getConfiguration: () => config, fetch });
    await expect(service.testConnection()).resolves.toEqual({
      ok: true,
      models: ["qwen"],
    });
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:8000/v1/models");
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
  });

  it("retries without response_format and validates cited evidence IDs", async () => {
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
    expect(
      JSON.parse(fetch.mock.calls[1][1].body).response_format,
    ).toBeUndefined();
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
    ).toThrow(/query/);
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
});
