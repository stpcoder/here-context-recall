import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LlmService } from "./llm-service";

type CapturedRequest = {
  method?: string;
  url?: string;
  authorization?: string;
  contentType?: string;
  body?: Record<string, unknown>;
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function startServer(
  handler: (request: IncomingMessage, body: Record<string, unknown>) => {
    status?: number;
    headers?: Record<string, string>;
    body: unknown;
  },
): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const result = handler(request, body);
    response.writeHead(result.status ?? 200, {
      "content-type": "application/json",
      ...result.headers,
    });
    response.end(
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port.");
  return `http://127.0.0.1:${address.port}/v1`;
}

function reconstructionBody(id = "here-connection-check"): unknown {
  return {
    id: "chatcmpl-here-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({
            summary: "Here 연결을 확인했습니다.",
            target: "OpenAI-compatible connection check",
            evidenceIds: [id],
            nextAction: "업무를 이어가세요.",
          }),
        },
      },
    ],
  };
}

describe("LlmService OpenAI-compatible wire integration", () => {
  it("calls a real HTTP /chat/completions endpoint with Bearer auth and JSON Schema", async () => {
    const captured: CapturedRequest[] = [];
    const endpoint = await startServer((request, body) => {
      captured.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body,
      });
      if (request.url === "/v1/models")
        return { body: { data: [{ id: "Qwen/Qwen3-32B" }] } };
      return {
        headers: { "x-request-id": "req-integration-1" },
        body: reconstructionBody(),
      };
    });
    const result = await new LlmService({
      getConfiguration: () => ({
        endpoint,
        model: "Qwen/Qwen3-32B",
        apiKey: "integration-token",
      }),
    }).testConnection();

    expect(result).toMatchObject({
      ok: true,
      reconstructionVerified: true,
      structuredOutputMode: "json-schema",
      selectedModel: "Qwen/Qwen3-32B",
      requestId: "req-integration-1",
      modelsEndpointAvailable: true,
    });
    expect(captured[0]).toMatchObject({
      method: "POST",
      url: "/v1/chat/completions",
      authorization: "Bearer integration-token",
      contentType: "application/json",
    });
    expect(captured[0].body).toMatchObject({
      model: "Qwen/Qwen3-32B",
      stream: false,
      response_format: { type: "json_schema" },
    });
    expect(captured[1]).toMatchObject({
      method: "GET",
      url: "/v1/models",
      authorization: "Bearer integration-token",
    });
  });

  it("works with a gateway that rejects JSON Schema but supports JSON object", async () => {
    const formats: Array<string | undefined> = [];
    const endpoint = await startServer((request, body) => {
      if (request.url === "/v1/models")
        return { status: 404, body: { error: "model discovery disabled" } };
      const responseFormat = body.response_format as
        | { type?: string }
        | undefined;
      formats.push(responseFormat?.type);
      if (responseFormat?.type === "json_schema")
        return {
          status: 400,
          body: { error: { message: "response_format json_schema unsupported" } },
        };
      return { body: reconstructionBody() };
    });
    const result = await new LlmService({
      getConfiguration: () => ({ endpoint, model: "internal-model" }),
    }).testConnection();

    expect(result).toMatchObject({
      ok: true,
      reconstructionVerified: true,
      structuredOutputMode: "json-object",
      modelsEndpointAvailable: false,
    });
    expect(formats).toEqual(["json_schema", "json_object"]);
  });

  it("proves text fallback over HTTP when a text-only model rejects image_url", async () => {
    const contentKinds: string[] = [];
    const endpoint = await startServer((request, body) => {
      if (request.url === "/v1/models")
        return { status: 404, body: { error: "hidden" } };
      const messages = body.messages as Array<{ content: unknown }>;
      const content = messages.at(-1)?.content;
      contentKinds.push(Array.isArray(content) ? "vision" : "text");
      if (Array.isArray(content))
        return {
          status: 415,
          body: { error: { message: "image_url is unsupported by this model" } },
        };
      return { body: reconstructionBody() };
    });
    const result = await new LlmService({
      getConfiguration: () => ({ endpoint, model: "text-only-model" }),
    }).testConnection(undefined, {
      visionRequested: true,
      vision: { mimeType: "image/png", dataBase64: "aGVyZQ==" },
    });

    expect(result).toMatchObject({
      ok: true,
      reconstructionVerified: true,
      visionRequested: true,
      visionVerified: false,
    });
    expect(result.warning).toContain("text-only");
    expect(contentKinds).toEqual(["vision", "text"]);
  });
});
