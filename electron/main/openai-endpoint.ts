const CHAT_SUFFIX = /\/chat\/completions\/?$/i;
const MODELS_SUFFIX = /\/models\/?$/i;

/**
 * Accept a user-facing OpenAI-compatible Base URL. If a full well-known API
 * route was pasted, reduce it back to the Base URL instead of producing a
 * duplicated `/chat/completions/chat/completions` request later.
 */
export function normalizeOpenAiEndpoint(value: string): string {
  const url = parseEndpoint(value);
  validateParsedEndpoint(url);
  url.pathname = url.pathname
    .replace(CHAT_SUFFIX, "")
    .replace(MODELS_SUFFIX, "")
    .replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

export function validateOpenAiEndpoint(value: string): void {
  const url = parseEndpoint(value);
  validateParsedEndpoint(url);
}

export function openAiApiUrl(endpoint: string, route: string): string {
  return `${normalizeOpenAiEndpoint(endpoint)}/${route.replace(/^\/+/, "")}`;
}

function parseEndpoint(value: string): URL {
  try {
    return new URL(value.trim());
  } catch {
    throw new Error("Enter a valid API Base URL.");
  }
}

function validateParsedEndpoint(url: URL): void {
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "API Base URL must not contain credentials, a query, or a fragment.",
    );
  if (url.protocol === "https:") return;
  if (url.protocol !== "http:" || !isLocalOrPrivateHost(url.hostname)) {
    throw new Error(
      "API Base URL must use HTTPS, except localhost or private-network HTTP.",
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
