import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ModelProvider } from "../shared/contracts";

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
    summary: z.string().trim().min(1).max(600),
    target: z.string().trim().min(1).max(300),
    evidenceIds: z.array(z.string().min(1)).min(1).max(20),
    nextAction: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

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

export class LlmService {
  private readonly getConfiguration: LlmServiceOptions["getConfiguration"];
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getVertexAccessToken: () => Promise<string>;
  private readonly getVertexProject: () => Promise<string>;

  constructor(options: LlmServiceOptions) {
    this.getConfiguration = options.getConfiguration;
    this.request = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 18_000;
    this.getVertexAccessToken =
      options.getVertexAccessToken ?? defaultGcloudAccessToken;
    this.getVertexProject = options.getVertexProject ?? defaultGcloudProject;
  }

  async testConnection(
    input?: LlmConfiguration,
  ): Promise<{ ok: boolean; models: string[]; error?: string }> {
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
        return { ok: true, models: [config.model] };
      }

      const response = await this.fetchWithTimeout(
        joinApiUrl(config.endpoint, "models"),
        { headers: this.openAiHeaders(config.apiKey) },
      );
      if (!response.ok)
        return {
          ok: false,
          models: [],
          error: `Model endpoint returned ${response.status}.`,
        };
      const body: unknown = await responseJson(response);
      const models = z
        .object({ data: z.array(z.object({ id: z.string() })) })
        .parse(body)
        .data.map(({ id }) => id);
      return { ok: true, models };
    } catch (error) {
      return { ok: false, models: [], error: readableError(error) };
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
    let response = await this.fetchWithTimeout(
      joinApiUrl(config.endpoint, "chat/completions"),
      {
        method: "POST",
        headers: this.openAiHeaders(config.apiKey),
        body: JSON.stringify(
          this.openAiPayload(config.model, evidence, true, current, vision),
        ),
      },
    );
    // vLLM and older compatible servers can reject response_format entirely.
    if (!response.ok && (response.status === 400 || response.status === 422)) {
      response = await this.fetchWithTimeout(
        joinApiUrl(config.endpoint, "chat/completions"),
        {
          method: "POST",
          headers: this.openAiHeaders(config.apiKey),
          body: JSON.stringify(
            this.openAiPayload(config.model, evidence, false, current, vision),
          ),
        },
      );
    }
    if (!response.ok)
      throw new Error(`Chat endpoint returned ${response.status}.`);
    const body: unknown = await responseJson(response);
    const content = z
      .object({
        choices: z
          .array(z.object({ message: z.object({ content: z.string() }) }))
          .min(1),
      })
      .parse(body).choices[0].message.content;
    return parseReconstruction(content);
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
    validateEndpoint(configuration.endpoint);
    return {
      ...configuration,
      modelProvider: "openai-compatible",
      endpoint: configuration.endpoint.replace(/\/+$/, ""),
      model: configuration.model.trim(),
    };
  }

  private openAiHeaders(apiKey?: string): HeadersInit {
    return {
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
    structured: boolean,
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
      messages: [
        { role: "system", content: systemPrompt(Boolean(vision)) },
        { role: "user", content },
      ],
    };
    if (structured) payload.response_format = { type: "json_object" };
    return payload;
  }

  private async fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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

export function validateEndpoint(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid API endpoint URL.");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "API endpoint must not contain credentials, a query, or a fragment.",
    );
  if (url.protocol === "https:") return;
  if (url.protocol !== "http:" || !isLocalOrPrivateHost(url.hostname)) {
    throw new Error(
      "API endpoint must use HTTPS, except localhost or private-network HTTP.",
    );
  }
}

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
    "Every evidenceIds value must be an ID from the supplied evidence.",
    hasImage
      ? "The image is context, not independent evidence; cite the matching window event ID."
      : "No screen image was provided.",
  ].join(" ");
}

function isLocalOrPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "host.docker.internal" ||
    normalized === "::1"
  )
    return true;
  const parts = normalized.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
  );
}

function joinApiUrl(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/, "")}/${path}`;
}

function parseReconstruction(value: string): z.infer<typeof reconstructionSchema> {
  return reconstructionSchema.parse(JSON.parse(stripCodeFence(value)));
}

function stripCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : "Connection failed.";
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
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES)
    throw new Error("Model response was too large.");
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES)
    throw new Error("Model response was too large.");
  return JSON.parse(body) as unknown;
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
