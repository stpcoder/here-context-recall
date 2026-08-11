import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/** A deliberately small subset of Electron's safeStorage, making this class testable. */
export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const shortcut = z.string().trim().min(3).max(100);
const endpoint = z.string().trim().url().max(2_048);

const persistedSettingsSchema = z.object({
  version: z.literal(1),
  modelProvider: z
    .enum(["openai-compatible", "vertex-gcloud"])
    .default("openai-compatible"),
  endpoint,
  // Empty is valid during first-run onboarding; LlmService rejects it at request time.
  model: z.string().trim().max(300),
  vertexProject: z.string().trim().max(300).default(""),
  vertexLocation: z.string().trim().min(1).max(100).default("global"),
  includeWindowImage: z.boolean().default(false),
  captureConsent: z.boolean(),
  shortcut,
  checkpointShortcut: shortcut.default("CommandOrControl+Shift+M"),
  retentionMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  excludedApps: z.array(z.string().trim().min(1).max(300)).max(100),
  showBubble: z.boolean(),
  autoStart: z.boolean(),
  encryptedApiKey: z.string().min(1).optional(),
});

export type PersistedSettings = z.infer<typeof persistedSettingsSchema>;
export type PublicSettings = Omit<PersistedSettings, "encryptedApiKey"> & {
  apiKeyConfigured: boolean;
};

export const settingsPatchSchema = persistedSettingsSchema
  .omit({ version: true, encryptedApiKey: true })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const DEFAULT_SETTINGS: Omit<PersistedSettings, "encryptedApiKey"> = {
  version: 1,
  modelProvider: "openai-compatible",
  endpoint: "http://127.0.0.1:8000/v1",
  model: "",
  vertexProject: "",
  vertexLocation: "global",
  includeWindowImage: false,
  captureConsent: false,
  shortcut: "CommandOrControl+Shift+Space",
  checkpointShortcut: "CommandOrControl+Shift+M",
  retentionMinutes: 10,
  excludedApps: [],
  showBubble: true,
  autoStart: false,
};

export type SettingsStoreOptions = {
  filePath: string;
  safeStorage: SafeStorage;
  /** Called by clearHistory; event records never belong in this settings JSON file. */
  clearHistory?: () => Promise<void> | void;
};

/**
 * Main-process only settings store. Never expose `getApiKey()` over IPC.
 * The renderer receives `PublicSettings` only.
 */
export class SettingsStore {
  private readonly filePath: string;
  private readonly safeStorage: SafeStorage;
  private readonly historyClearer?: () => Promise<void> | void;

  constructor(options: SettingsStoreOptions) {
    this.filePath = options.filePath;
    this.safeStorage = options.safeStorage;
    this.historyClearer = options.clearHistory;
  }

  async get(): Promise<PublicSettings> {
    return this.toPublic(await this.read());
  }

  /** Call once at application startup to validate/migrate the settings file. */
  async initialize(): Promise<PublicSettings> {
    return this.get();
  }

  /** Explicit renderer-safe name for IPC handlers. */
  async getPublic(): Promise<PublicSettings> {
    return this.get();
  }

  async update(patch: SettingsPatch): Promise<PublicSettings> {
    const validPatch = settingsPatchSchema.parse(patch);
    const current = await this.read();
    const next = persistedSettingsSchema.parse({
      ...current,
      ...validPatch,
      endpoint: validPatch.endpoint
        ? normalizeEndpoint(validPatch.endpoint)
        : current.endpoint,
      excludedApps: validPatch.excludedApps
        ? normalizeExcludedApps(validPatch.excludedApps)
        : current.excludedApps,
    });
    await this.write(next);
    return this.toPublic(next);
  }

  /** Explicit renderer-safe name for IPC handlers. API keys use setApiKey separately. */
  async save(input: SettingsPatch): Promise<PublicSettings> {
    return this.update(input);
  }

  async setApiKey(apiKey: string): Promise<PublicSettings> {
    const key = apiKey.trim();
    if (!key) throw new Error("API key cannot be empty.");
    if (key.length > 8_192) throw new Error("API key is too long.");
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("OS encryption is unavailable; API key was not saved.");
    }
    const current = await this.read();
    const next = {
      ...current,
      encryptedApiKey: this.safeStorage.encryptString(key).toString("base64"),
    };
    await this.write(persistedSettingsSchema.parse(next));
    return this.toPublic(next);
  }

  async clearApiKey(): Promise<PublicSettings> {
    const current = await this.read();
    const { encryptedApiKey: _key, ...withoutKey } = current;
    await this.write(withoutKey);
    return this.toPublic(withoutKey);
  }

  /** Main-process consumers only; do not wire this method to ipcMain.handle. */
  async getApiKey(): Promise<string | undefined> {
    const encrypted = (await this.read()).encryptedApiKey;
    if (!encrypted) return undefined;
    if (!this.safeStorage.isEncryptionAvailable()) return undefined;
    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      // A changed OS user/profile makes the old key unreadable. Do not surface ciphertext.
      return undefined;
    }
  }

  async clearHistory(): Promise<void> {
    await this.historyClearer?.();
  }

  async getHistoryPolicy(): Promise<
    Pick<PublicSettings, "retentionMinutes" | "excludedApps" | "captureConsent">
  > {
    const { retentionMinutes, excludedApps, captureConsent } = await this.get();
    return { retentionMinutes, excludedApps, captureConsent };
  }

  private async read(): Promise<PersistedSettings> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      const settings = persistedSettingsSchema.parse(parsed);
      return {
        ...settings,
        endpoint: normalizeEndpoint(settings.endpoint),
        excludedApps: normalizeExcludedApps(settings.excludedApps),
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ...DEFAULT_SETTINGS };
      // Invalid preferences must never preserve tracking consent. Keep the
      // unreadable file for recovery, then restart from consent-off defaults.
      try {
        await rename(this.filePath, `${this.filePath}.invalid-${Date.now()}`);
      } catch {
        // Recovery backup is best-effort; safe defaults still take priority.
      }
      return { ...DEFAULT_SETTINGS };
    }
  }

  private async write(settings: PersistedSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }

  private toPublic(settings: PersistedSettings): PublicSettings {
    const { encryptedApiKey, ...publicSettings } = settings;
    return { ...publicSettings, apiKeyConfigured: Boolean(encryptedApiKey) };
  }
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeExcludedApps(apps: string[]): string[] {
  return [...new Set(apps.map((app) => app.trim()).filter(Boolean))];
}
