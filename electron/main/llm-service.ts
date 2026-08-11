import { z } from "zod";

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

const MAX_RESPONSE_BYTES = 1_000_000;

export type LlmConfiguration = {
  endpoint: string;
  model: string;
  apiKey?: string;
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
};

export class LlmService {
  private readonly getConfiguration: LlmServiceOptions["getConfiguration"];
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LlmServiceOptions) {
    this.getConfiguration = options.getConfiguration;
    this.request = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  async testConnection(
    input?: LlmConfiguration,
  ): Promise<{ ok: boolean; models: string[]; error?: string }> {
    try {
      const configuration = input ?? (await this.getConfiguration());
      validateEndpoint(configuration.endpoint);
      const config = {
        ...configuration,
        endpoint: configuration.endpoint.replace(/\/+$/, ""),
      };
      const response = await this.fetchWithTimeout(
        joinApiUrl(config.endpoint, "models"),
        {
          headers: this.headers(config.apiKey),
        },
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
  ): Promise<Reconstruction> {
    const safeEvidence = validateEvidence(evidence);
    if (safeEvidence.length === 0) return localFallback([], current);
    try {
      const config = await this.getValidConfiguration();
      const payload = this.chatPayload(
        config.model,
        safeEvidence,
        true,
        current,
      );
      let response = await this.fetchWithTimeout(
        joinApiUrl(config.endpoint, "chat/completions"),
        {
          method: "POST",
          headers: this.headers(config.apiKey),
          body: JSON.stringify(payload),
        },
      );
      // vLLM and older compatible servers can reject response_format entirely.
      if (
        !response.ok &&
        (response.status === 400 || response.status === 422)
      ) {
        response = await this.fetchWithTimeout(
          joinApiUrl(config.endpoint, "chat/completions"),
          {
            method: "POST",
            headers: this.headers(config.apiKey),
            body: JSON.stringify(
              this.chatPayload(config.model, safeEvidence, false, current),
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
      const result = reconstructionSchema.parse(
        JSON.parse(stripCodeFence(content)),
      );
      assertEvidenceReferences(result.evidenceIds, safeEvidence);
      return { ...result, source: "model" };
    } catch {
      return localFallback(safeEvidence, current);
    }
  }

  private async getValidConfiguration(
    input?: LlmConfiguration,
  ): Promise<LlmConfiguration> {
    const configuration = input ?? (await this.getConfiguration());
    validateEndpoint(configuration.endpoint);
    if (!configuration.model.trim()) throw new Error("Choose a model first.");
    return {
      ...configuration,
      endpoint: configuration.endpoint.replace(/\/+$/, ""),
      model: configuration.model.trim(),
    };
  }

  private headers(apiKey?: string): HeadersInit {
    return {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
  }

  private chatPayload(
    model: string,
    evidence: Evidence[],
    structured: boolean,
    current?: ReconstructionCurrent,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Reconstruct why the user reached the current window. Use only given evidence; never invent intent or content. Return concise JSON with Korean summary, target, evidenceIds, nextAction. evidenceIds must be IDs from evidence.",
        },
        { role: "user", content: JSON.stringify({ evidence, current }) },
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
        ? `${trigger.app} activity led to ${target}.`
        : "No recent activity was captured yet.",
    target: target ?? "Recent activity",
    evidenceIds: cited,
    nextAction: target ? `Resume ${target}.` : undefined,
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
