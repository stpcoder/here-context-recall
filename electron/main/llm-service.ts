import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ModelProvider } from "../shared/contracts";
import type { ConnectionTestResult } from "../shared/contracts";
import {
  normalizeOpenAiEndpoint,
  openAiApiUrl,
  validateOpenAiEndpoint,
} from "./openai-endpoint";

export type Evidence = {
  id: string;
  at: string;
  app: string;
  title: string;
  kind: "focus" | "click" | "file" | "message" | "interruption";
  detail?: string;
};

export type Reconstruction = {
  summary: string;
  target: string;
  evidenceIds: string[];
  nextAction?: string;
  source: "model" | "fallback";
};

export type VisionContext = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  dataBase64: string;
};

const reconstructionSchema = z
  .object({
    summary: z.string().trim().min(1).max(160),
    target: z.string().trim().min(1).max(160),
    evidenceIds: z.array(z.string().min(1)).min(1).max(20),
    nextAction: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .nullish()
      .transform((value) => value ?? undefined),
  })
  // Prompt-only OpenAI-compatible servers sometimes add harmless metadata.
  // Keep the consumed contract narrow without rejecting the whole result.
  .strip();

const evidenceSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    at: z.string().trim().min(1).max(80),
    app: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(512),
    kind: z.enum(["focus", "click", "file", "message", "interruption"]),
    detail: z.string().trim().max(512).optional(),
  })
  .strict();

const visionSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  dataBase64: z
    .string()
    .min(1)
    .max(7_500_000)
    .regex(/^[A-Za-z0-9+/=]+$/),
});

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ERROR_BYTES = 16_384;
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const OPENAI_RECONSTRUCTION_MAX_TOKENS = 768;
const OPENAI_CONNECTION_MAX_TOKENS = 384;
const execFileAsync = promisify(execFile);
let cachedGcloudToken: { value: string; expiresAt: number } | undefined;
let cachedGcloudProject: { value: string; expiresAt: number } | undefined;

export type LlmConfiguration = {
  modelProvider?: ModelProvider;
  endpoint: string;
  model: string;
  apiKey?: string;
  vertexProject?: string;
  vertexLocation?: string;
};
export type ReconstructionCurrent = Pick<
  Partial<Evidence>,
  "id" | "app" | "title"
>;
export type LocalFallback = (
  evidence: Evidence[],
  current?: ReconstructionCurrent,
) => Reconstruction;
export type LlmServiceOptions = {
  getConfiguration: () => Promise<LlmConfiguration> | LlmConfiguration;
  fetch?: typeof fetch;
  timeoutMs?: number;
  getVertexAccessToken?: () => Promise<string>;
  getVertexProject?: () => Promise<string>;
};

export type OpenAiOutputMode =
  | "json-schema"
  | "json-object"
  | "prompt-only";

export type ConnectionTestOptions = {
  /** A built-in, non-user image used only to prove the configured model is multimodal. */
  vision?: VisionContext;
  visionRequested?: boolean;
};

type OpenAiReconstructionResult = {
  reconstruction: z.infer<typeof reconstructionSchema>;
  outputMode: OpenAiOutputMode;
  visionUsed: boolean;
  requestId?: string;
};

type OpenAiAttempt = {
  outputMode: OpenAiOutputMode;
  vision?: VisionContext;
};

export class LlmService {
  private readonly getConfiguration: LlmServiceOptions["getConfiguration"];
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getVertexAccessToken: () => Promise<string>;
  private readonly getVertexProject: () => Promise<string>;
  private readonly preferredOutputModes = new Map<string, OpenAiOutputMode>();
  private readonly visionSupport = new Map<string, boolean>();

  constructor(options: LlmServiceOptions) {
    this.getConfiguration = options.getConfiguration;
    this.request = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.getVertexAccessToken =
      options.getVertexAccessToken ?? defaultGcloudAccessToken;
    this.getVertexProject = options.getVertexProject ?? defaultGcloudProject;
  }

  async testConnection(
    input?: LlmConfiguration,
    options: ConnectionTestOptions = {},
  ): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    try {
      const config = await this.getValidConfiguration(input);
      if (provider(config) === "vertex-gcloud") {
        const response = await this.fetchWithTimeout(vertexModelUrl(config), {
          method: "POST",
          headers: await this.vertexHeaders(),
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: "Return exactly HERE_OK." }],
              },
            ],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 256,
              thinkingConfig: { thinkingBudget: 64 },
            },
          }),
        });
        if (!response.ok)
          return {
            ok: false,
            models: [],
            error: await vertexError(response),
          };
        await responseJson(response);
        return {
          ok: true,
          models: [config.model],
          selectedModel: config.model,
          chatCompletionVerified: true,
          reconstructionVerified: true,
          modelsEndpointAvailable: false,
          latencyMs: Date.now() - startedAt,
        };
      }

      // Exercise the same grounded JSON contract that Here uses during a real
      // recall. A generic "hello" response proves transport only and can hide
      // an unusable chat template or structured-output configuration.
      const probeEvidence: Evidence[] = [
        {
          id: "here-connection-check",
          at: "2026-01-01T00:00:00.000Z",
          app: "Here",
          title: "OpenAI-compatible connection check",
          kind: "focus",
        },
      ];
      const probe = await this.requestOpenAiReconstruction(
        config,
        probeEvidence,
        {
          id: probeEvidence[0].id,
          app: probeEvidence[0].app,
          title: probeEvidence[0].title,
        },
        options.vision,
        OPENAI_CONNECTION_MAX_TOKENS,
      );
      assertEvidenceReferences(
        probe.reconstruction.evidenceIds,
        probeEvidence,
      );

      let models = [config.model];
      let modelsEndpointAvailable = false;
      try {
        const modelsResponse = await this.fetchWithTimeout(
          openAiApiUrl(config.endpoint, "models"),
          { headers: this.openAiHeaders(config.apiKey) },
          MODEL_DISCOVERY_TIMEOUT_MS,
        );
        if (modelsResponse.ok) {
          models = z
            .object({ data: z.array(z.object({ id: z.string() })) })
            .parse(await responseJson(modelsResponse))
            .data.map(({ id }) => id);
          modelsEndpointAvailable = true;
        }
      } catch {
        // Some internal gateways expose chat completions but intentionally do
        // not expose model discovery. The verified chat call remains decisive.
      }
      if (!models.includes(config.model)) models.unshift(config.model);
      const visionRequested = Boolean(options.visionRequested || options.vision);
      const warning =
        visionRequested && !probe.visionUsed
          ? "이미지 입력은 지원되지 않아 창 제목 근거를 사용하는 text-only 모드로 확인했습니다."
          : undefined;
      return {
        ok: true,
        models,
        selectedModel: config.model,
        chatCompletionVerified: true,
        reconstructionVerified: true,
        structuredOutputMode: probe.outputMode,
        visionRequested,
        visionVerified: visionRequested ? probe.visionUsed : undefined,
        modelsEndpointAvailable,
        latencyMs: Date.now() - startedAt,
        requestId: probe.requestId,
        warning,
      };
    } catch (error) {
      return {
        ok: false,
        models: [],
        chatCompletionVerified: false,
        reconstructionVerified: false,
        visionRequested: Boolean(options.visionRequested || options.vision),
        visionVerified: false,
        modelsEndpointAvailable: false,
        latencyMs: Date.now() - startedAt,
        error: readableError(error),
      };
    }
  }

  async reconstruct(
    evidence: Evidence[],
    current?: ReconstructionCurrent,
    localFallback: LocalFallback = deterministicFallback,
    vision?: VisionContext,
  ): Promise<Reconstruction> {
    const safeEvidence = validateEvidence(evidence);
    const safeVision = vision ? visionSchema.parse(vision) : undefined;
    if (safeEvidence.length === 0) return localFallback([], current);
    try {
      const config = await this.getValidConfiguration();
      const result =
        provider(config) === "vertex-gcloud"
          ? await this.reconstructVertex(
              config,
              safeEvidence,
              current,
              safeVision,
            )
          : await this.reconstructOpenAi(
              config,
              safeEvidence,
              current,
              safeVision,
            );
      assertEvidenceReferences(result.evidenceIds, safeEvidence);
      return { ...result, source: "model" };
    } catch {
      return localFallback(safeEvidence, current);
    }
  }

  private async reconstructOpenAi(
    config: LlmConfiguration,
    evidence: Evidence[],
    current?: ReconstructionCurrent,
    vision?: VisionContext,
  ): Promise<z.infer<typeof reconstructionSchema>> {
    return (
      await this.requestOpenAiReconstruction(
        config,
        evidence,
        current,
        vision,
        OPENAI_RECONSTRUCTION_MAX_TOKENS,
      )
    ).reconstruction;
  }

  private async requestOpenAiReconstruction(
    config: LlmConfiguration,
    evidence: Evidence[],
    current: ReconstructionCurrent | undefined,
    vision: VisionContext | undefined,
    maxTokens: number,
  ): Promise<OpenAiReconstructionResult> {
    const capabilityKey = this.openAiCapabilityKey(config);
    const canTryVision =
      Boolean(vision) && this.visionSupport.get(capabilityKey) !== false;
    const attempts = [
      ...(canTryVision
        ? this.openAiAttempts(config, vision)
        : []),
      ...this.openAiAttempts(config, undefined),
    ];
    let skipRemainingVision = false;
    let sawVisionFailure = false;
    let lastError: Error | undefined;

    for (const attempt of attempts) {
      if (attempt.vision && skipRemainingVision) continue;
      const response = await this.fetchWithTimeout(
        openAiApiUrl(config.endpoint, "chat/completions"),
        {
          method: "POST",
          headers: this.openAiHeaders(config.apiKey),
          body: JSON.stringify(
            this.openAiPayload(
              config.model,
              evidence,
              attempt.outputMode,
              maxTokens,
              current,
              attempt.vision,
            ),
          ),
        },
      );
      const requestId = responseRequestId(response);
      if (response.ok) {
        try {
          const reconstruction = parseReconstruction(
            parseChatContent(await responseJson(response)),
          );
          assertEvidenceReferences(reconstruction.evidenceIds, evidence);
          this.preferredOutputModes.set(
            this.openAiModeKey(config, Boolean(attempt.vision)),
            attempt.outputMode,
          );
          if (attempt.vision) this.visionSupport.set(capabilityKey, true);
          else if (vision && sawVisionFailure)
            this.visionSupport.set(capabilityKey, false);
          return {
            reconstruction,
            outputMode: attempt.outputMode,
            visionUsed: Boolean(attempt.vision),
            requestId,
          };
        } catch (error) {
          lastError = new Error(
            `선택한 모델이 Here 복원 JSON을 반환하지 않았습니다 (${outputModeLabel(attempt.outputMode)}).`,
            { cause: error },
          );
          if (attempt.vision) sawVisionFailure = true;
          continue;
        }
      }

      const detail = await openAiErrorDetail(response, config.apiKey);
      lastError = new Error(
        openAiConnectionError(response.status, detail.message, requestId),
      );
      if (
        !isRetryableOpenAiStatus(response.status, Boolean(attempt.vision))
      )
        throw lastError;
      if (attempt.vision) {
        sawVisionFailure = true;
        if (
          response.status === 413 ||
          response.status === 415 ||
          indicatesVisionRejection(detail.message)
        )
          skipRemainingVision = true;
      }
    }

    throw (
      lastError ??
      new Error("선택한 모델로 Here 복원 형식을 확인하지 못했습니다.")
    );
  }

  private openAiAttempts(
    config: LlmConfiguration,
    vision?: VisionContext,
  ): OpenAiAttempt[] {
    const preferred = this.preferredOutputModes.get(
      this.openAiModeKey(config, Boolean(vision)),
    );
    const modes: OpenAiOutputMode[] = [
      "json-schema",
      "json-object",
      "prompt-only",
    ];
    if (preferred)
      modes.sort(
        (left, right) =>
          Number(right === preferred) - Number(left === preferred),
      );
    return modes.map((outputMode) => ({ outputMode, vision }));
  }

  private openAiCapabilityKey(config: LlmConfiguration): string {
    return `${config.endpoint}\u0000${config.model}`;
  }

  private openAiModeKey(
    config: LlmConfiguration,
    vision: boolean,
  ): string {
    return `${this.openAiCapabilityKey(config)}\u0000${vision ? "vision" : "text"}`;
  }

  private async reconstructVertex(
    config: LlmConfiguration,
    evidence: Evidence[],
    current?: ReconstructionCurrent,
    vision?: VisionContext,
  ): Promise<z.infer<typeof reconstructionSchema>> {
    const parts: Array<Record<string, unknown>> = [
      {
        text: JSON.stringify({ evidence, current }),
      },
    ];
    if (vision)
      parts.push({
        inlineData: {
          mimeType: vision.mimeType,
          data: vision.dataBase64,
        },
      });
    const response = await this.fetchWithTimeout(vertexModelUrl(config), {
      method: "POST",
      headers: await this.vertexHeaders(),
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt(Boolean(vision)) }],
        },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 1_024,
          thinkingConfig: { thinkingBudget: 128 },
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            required: ["summary", "target", "evidenceIds"],
            properties: {
              summary: { type: "STRING" },
              target: { type: "STRING" },
              evidenceIds: { type: "ARRAY", items: { type: "STRING" } },
              nextAction: { type: "STRING" },
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(await vertexError(response));
    const body: unknown = await responseJson(response);
    const parsed = z
      .object({
        candidates: z
          .array(
            z.object({
              content: z.object({
                parts: z.array(
                  z.object({ text: z.string().optional() }).passthrough(),
                ),
              }),
            }),
          )
          .min(1),
      })
      .parse(body);
    const content = parsed.candidates[0].content.parts
      .flatMap((part) => (part.text ? [part.text] : []))
      .join("");
    return parseReconstruction(content);
  }

  private async getValidConfiguration(
    input?: LlmConfiguration,
  ): Promise<LlmConfiguration> {
    const configuration = input ?? (await this.getConfiguration());
    if (!configuration.model.trim()) throw new Error("Choose a model first.");
    if (provider(configuration) === "vertex-gcloud") {
      const next: LlmConfiguration = {
        ...configuration,
        modelProvider: "vertex-gcloud",
        model: configuration.model.trim(),
        vertexProject:
          configuration.vertexProject?.trim() || (await this.getVertexProject()),
        vertexLocation: (configuration.vertexLocation || "global").trim(),
      };
      validateVertexConfiguration(next);
      return next;
    }
    validateOpenAiEndpoint(configuration.endpoint);
    return {
      ...configuration,
      modelProvider: "openai-compatible",
      endpoint: normalizeOpenAiEndpoint(configuration.endpoint),
      model: configuration.model.trim(),
      apiKey: configuration.apiKey?.trim() || undefined,
    };
  }

  private openAiHeaders(apiKey?: string): HeadersInit {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
  }

  private async vertexHeaders(): Promise<HeadersInit> {
    const token = (await this.getVertexAccessToken()).trim();
    if (!token || token.length > 8_192)
      throw new Error("gcloud did not return a usable access token.");
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }

  private openAiPayload(
    model: string,
    evidence: Evidence[],
    outputMode: OpenAiOutputMode,
    maxTokens: number,
    current?: ReconstructionCurrent,
    vision?: VisionContext,
  ): Record<string, unknown> {
    const data = JSON.stringify({ evidence, current });
    const content: unknown = vision
      ? [
          { type: "text", text: data },
          {
            type: "image_url",
            image_url: {
              url: `data:${vision.mimeType};base64,${vision.dataBase64}`,
            },
          },
        ]
      : data;
    const payload: Record<string, unknown> = {
      model,
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt(Boolean(vision)) },
        { role: "user", content },
      ],
    };
    if (outputMode === "json-schema")
      payload.response_format = {
        type: "json_schema",
        json_schema: {
          name: "here_reconstruction",
          strict: true,
          schema: reconstructionJsonSchema(evidence),
        },
      };
    else if (outputMode === "json-object")
      payload.response_format = { type: "json_object" };
    return payload;
  }

  private async fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.request(input, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export const validateEndpoint = validateOpenAiEndpoint;

function validateVertexConfiguration(config: LlmConfiguration): void {
  const project = config.vertexProject?.trim() ?? "";
  const location = config.vertexLocation?.trim() || "global";
  const model = config.model.trim();
  if (!/^(?:[a-z][a-z0-9-]{4,62}|[0-9]{6,20})$/.test(project))
    throw new Error("Enter a valid Google Cloud project ID.");
  if (!/^[a-z0-9-]{2,40}$/.test(location))
    throw new Error("Enter a valid Vertex location.");
  if (!/^[A-Za-z0-9._@-]{2,200}$/.test(model))
    throw new Error("Enter a valid Vertex model ID.");
}

function provider(config: LlmConfiguration): ModelProvider {
  return config.modelProvider ?? "openai-compatible";
}

function vertexModelUrl(config: LlmConfiguration): string {
  validateVertexConfiguration(config);
  const project = encodeURIComponent(config.vertexProject!.trim());
  const location = (config.vertexLocation || "global").trim();
  const model = encodeURIComponent(config.model.trim());
  const host =
    location === "global"
      ? "aiplatform.googleapis.com"
      : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${encodeURIComponent(location)}/publishers/google/models/${model}:generateContent`;
}

async function defaultGcloudAccessToken(): Promise<string> {
  if (cachedGcloudToken && cachedGcloudToken.expiresAt > Date.now())
    return cachedGcloudToken.value;
  const candidates = [
    ["auth", "application-default", "print-access-token"],
    ["auth", "print-access-token"],
  ];
  for (const args of candidates) {
    try {
      const token = await runGcloud(args, 10_000);
      if (token) {
        cachedGcloudToken = {
          value: token,
          expiresAt: Date.now() + 30 * 60 * 1_000,
        };
        return token;
      }
    } catch {
      // Try the signed-in gcloud account when ADC is not configured.
    }
  }
  throw new Error(
    "gcloud authentication is unavailable. Run gcloud auth application-default login.",
  );
}

async function defaultGcloudProject(): Promise<string> {
  if (cachedGcloudProject && cachedGcloudProject.expiresAt > Date.now())
    return cachedGcloudProject.value;
  try {
    const project = await runGcloud(
      ["config", "get-value", "project"],
      8_000,
    );
    if (project && project !== "(unset)") {
      cachedGcloudProject = {
        value: project,
        expiresAt: Date.now() + 5 * 60 * 1_000,
      };
      return project;
    }
  } catch {
    // A clear error below keeps command details and local paths out of the UI.
  }
  throw new Error(
    "No gcloud project is configured. Set one with gcloud config set project PROJECT_ID.",
  );
}

async function runGcloud(args: string[], timeout: number): Promise<string> {
  let lastError: unknown;
  for (const executable of gcloudExecutables()) {
    try {
      const { stdout } = await execFileAsync(executable, args, {
        encoding: "utf8",
        timeout,
        windowsHide: true,
        maxBuffer: 32_000,
        // Google Cloud CLI is distributed as gcloud.cmd on Windows. Node can
        // execute that command shim only through the system shell.
        shell: process.platform === "win32",
      });
      return String(stdout).trim();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("gcloud executable was not found.");
}

function gcloudExecutables(): string[] {
  const configured = process.env.HERE_GCLOUD_PATH?.trim();
  const home = homedir();
  const candidates =
    process.platform === "win32"
      ? [
          configured,
          "gcloud.cmd",
          join(
            process.env.LOCALAPPDATA || home,
            "Google",
            "Cloud SDK",
            "google-cloud-sdk",
            "bin",
            "gcloud.cmd",
          ),
          join(
            process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
            "Google",
            "Cloud SDK",
            "google-cloud-sdk",
            "bin",
            "gcloud.cmd",
          ),
        ]
      : [
          configured,
          "gcloud",
          join(home, "google-cloud-sdk", "bin", "gcloud"),
          "/opt/homebrew/bin/gcloud",
          "/usr/local/bin/gcloud",
          "/opt/homebrew/share/google-cloud-sdk/bin/gcloud",
        ];
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

function systemPrompt(hasImage: boolean): string {
  return [
    "Reconstruct what the user was doing and why they reached or saved the current window.",
    "Use only the supplied activity evidence and the optional user-approved screenshot.",
    "Do not invent messages, values, files, intent, or actions that are not visible in those inputs.",
    "Return concise JSON in Korean with summary, target, evidenceIds, and one nextAction.",
    "Write summary as a natural answer about the interrupted task, preferably naming the observed requester or topic; do not use the repetitive template 'X하려고 Y로 돌아왔어요'.",
    "Keep summary under 60 Korean characters, target as the most precise visible work item or location, and nextAction as one short executable step without polite endings.",
    "Every evidenceIds value must be an ID from the supplied evidence.",
    hasImage
      ? "The image is context, not independent evidence; cite the matching window event ID."
      : "No screen image was provided.",
  ].join(" ");
}

function reconstructionJsonSchema(evidence: Evidence[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "target", "evidenceIds", "nextAction"],
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 160 },
      target: { type: "string", minLength: 1, maxLength: 160 },
      evidenceIds: {
        type: "array",
        minItems: 1,
        maxItems: Math.min(20, evidence.length),
        uniqueItems: true,
        items: { type: "string", enum: evidence.map(({ id }) => id) },
      },
      nextAction: {
        type: ["string", "null"],
        minLength: 1,
        maxLength: 160,
      },
    },
  };
}

function parseReconstruction(value: string): z.infer<typeof reconstructionSchema> {
  const normalized = stripCodeFence(
    value.replace(/<think>[\s\S]*?<\/think>/gi, ""),
  );
  const candidates = [normalized, ...extractJsonObjects(normalized)];
  let lastError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    try {
      return reconstructionSchema.parse(JSON.parse(candidate));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Model did not return JSON.");
}

function stripCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

function extractJsonObjects(value: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "모델 서버가 설정된 응답 제한 시간을 넘었습니다.";
  const detail = [
    error instanceof Error ? error.message : "",
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : "",
  ].join(" ");
  if (/CERT_|certificate|ERR_SSL|TLS/i.test(detail))
    return "사내 TLS 인증서를 OS 신뢰 저장소에서 확인해 주세요.";
  if (/ENOTFOUND|NAME_NOT_RESOLVED|dns/i.test(detail))
    return "Base URL의 호스트 이름을 찾지 못했습니다.";
  if (/ECONNREFUSED|CONNECTION_REFUSED/i.test(detail))
    return "모델 서버가 연결을 거부했습니다. 주소와 포트를 확인해 주세요.";
  if (error instanceof TypeError) return "모델 서버에 연결하지 못했습니다.";
  return error instanceof Error ? error.message : "연결하지 못했습니다.";
}

function parseChatContent(body: unknown): string {
  const message = z
    .object({
      choices: z
        .array(
          z.object({
            message: z
              .object({
                content: z
                  .union([
                    z.string(),
                    z.array(
                      z
                        .object({ text: z.string().optional() })
                        .passthrough(),
                    ),
                    z.null(),
                  ])
                  .optional(),
                reasoning_content: z.string().optional(),
              })
              .passthrough(),
          }),
        )
        .min(1),
    })
    .parse(body).choices[0].message;
  const content =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.text ? [part.text] : [])).join("")
        : "";
  const result = content.trim() || message.reasoning_content?.trim() || "";
  if (!result) throw new Error("Model response did not contain text.");
  return result;
}

function openAiConnectionError(
  status: number,
  detail?: string,
  requestId?: string,
): string {
  let message: string;
  if (status === 401) message = "Bearer token이 거부되었습니다 (401).";
  else if (status === 403)
    message = "선택한 모델을 호출할 권한이 없습니다 (403).";
  else if (status === 404)
    message = "Base URL의 /chat/completions 경로를 찾지 못했습니다 (404).";
  else if (status === 413)
    message = "이미지 요청 크기가 모델 서버 제한을 넘었습니다 (413).";
  else if (status === 415)
    message = "선택한 모델 또는 게이트웨이가 이미지 입력을 지원하지 않습니다 (415).";
  else if (status === 429)
    message = "모델 서버가 요청을 제한했습니다 (429).";
  else if (status === 400 || status === 422)
    message = `Model ID, chat template 또는 OpenAI 호환 설정을 확인하세요 (${status}).`;
  else if (status >= 500)
    message = `모델 서버가 오류를 반환했습니다 (${status}).`;
  else message = `Chat completion 호출에 실패했습니다 (${status}).`;
  const suffix = [detail, requestId ? `request ${requestId}` : undefined]
    .filter(Boolean)
    .join(" · ");
  return suffix ? `${message} ${suffix}` : message;
}

function isRetryableOpenAiStatus(status: number, vision: boolean): boolean {
  return (
    status === 400 ||
    status === 422 ||
    (vision && (status === 413 || status === 415))
  );
}

function indicatesVisionRejection(message?: string): boolean {
  return Boolean(
    message &&
      /image|vision|multimodal|multi-modal|image_url|content format/i.test(message),
  );
}

function outputModeLabel(mode: OpenAiOutputMode): string {
  if (mode === "json-schema") return "JSON Schema";
  if (mode === "json-object") return "JSON object";
  return "prompt-only JSON";
}

function responseRequestId(response: Response): string | undefined {
  return sanitizeDiagnostic(
    response.headers.get("x-request-id") ??
      response.headers.get("x-vllm-request-id") ??
      "",
    120,
  );
}

async function openAiErrorDetail(
  response: Response,
  apiKey?: string,
): Promise<{ message?: string }> {
  try {
    const text = await readLimitedText(response, MAX_ERROR_BYTES);
    let value = text;
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown } | string;
        message?: unknown;
        detail?: unknown;
      };
      value =
        typeof parsed.error === "object" &&
        parsed.error &&
        typeof parsed.error.message === "string"
          ? parsed.error.message
          : typeof parsed.error === "string"
            ? parsed.error
            : typeof parsed.message === "string"
              ? parsed.message
              : typeof parsed.detail === "string"
                ? parsed.detail
                : text;
    } catch {
      // Plain-text errors are common behind internal gateways.
    }
    return {
      message: sanitizeDiagnostic(
        value,
        260,
        apiKey?.trim() ? [apiKey.trim()] : [],
      ),
    };
  } catch {
    return {};
  }
}

function sanitizeDiagnostic(
  value: string,
  maxLength: number,
  secrets: string[] = [],
): string | undefined {
  const withoutExactSecrets = secrets
    .filter((secret) => secret.length >= 4)
    .reduce(
      (text, secret) => text.split(secret).join("[redacted]"),
      value,
    );
  const sanitized = withoutExactSecrets
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return sanitized || undefined;
}

function validateEvidence(evidence: Evidence[]): Evidence[] {
  const ids = new Set<string>();
  return evidence.slice(0, 20).flatMap((item) => {
    const parsed = evidenceSchema.safeParse(item);
    if (!parsed.success || ids.has(parsed.data.id)) return [];
    ids.add(parsed.data.id);
    return [parsed.data];
  });
}

function assertEvidenceReferences(
  references: string[],
  evidence: Evidence[],
): void {
  const allowed = new Set(evidence.map(({ id }) => id));
  if (references.some((id) => !allowed.has(id)))
    throw new Error("Model cited unknown observation.");
}

export function deterministicFallback(
  evidence: Evidence[],
  current?: ReconstructionCurrent,
): Reconstruction {
  const cited = evidence.slice(-3).map(({ id }) => id);
  const lastEvent = evidence.at(-1);
  const trigger =
    [...evidence]
      .reverse()
      .find((event) => event.kind === "message" || event.kind === "click") ??
    evidence[0];
  const target = current?.title ?? lastEvent?.title;
  return {
    summary:
      target && trigger
        ? `${trigger.app}에서 ${target}까지 이어진 흐름입니다.`
        : "최근 활동이 아직 충분하지 않습니다.",
    target: target ?? "최근 활동",
    evidenceIds: cited,
    nextAction: target ? `${target} 작업을 이어가세요.` : undefined,
    source: "fallback",
  };
}

async function responseJson(response: Response): Promise<unknown> {
  return JSON.parse(await readLimitedText(response, MAX_RESPONSE_BYTES)) as unknown;
}

async function readLimitedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new Error("Model response was too large.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Model response was too large.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function vertexError(response: Response): Promise<string> {
  try {
    const body = z
      .object({ error: z.object({ message: z.string() }) })
      .parse(await responseJson(response));
    return `Vertex AI: ${body.error.message}`;
  } catch {
    return `Vertex AI returned ${response.status}.`;
  }
}
