import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SettingsStore, type SafeStorage } from "./settings-store";

const safeStorage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => value.toString().replace("encrypted:", ""),
};

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "here-settings-"));
  return new SettingsStore({
    filePath: join(directory, "settings.json"),
    safeStorage,
  });
}

describe("SettingsStore", () => {
  it("never returns an API key to public settings and encrypts it at rest", async () => {
    const settings = await store();
    await settings.setApiKey("top-secret");
    expect(
      (await settings.get()) as Record<string, unknown>,
    ).not.toHaveProperty("encryptedApiKey");
    expect(await settings.getApiKey()).toBe("top-secret");
    const raw = await readFile(
      (settings as unknown as { filePath: string }).filePath,
      "utf8",
    );
    expect(raw).not.toContain("top-secret");
  });

  it("normalizes endpoint and excludes apps without changing the key", async () => {
    const settings = await store();
    await settings.setApiKey("key");
    const next = await settings.update({
      endpoint: "http://127.0.0.1:8000/v1/",
      excludedApps: [" Slack ", "Slack"],
    });
    expect(next.endpoint).toBe("http://127.0.0.1:8000/v1");
    expect(next.excludedApps).toEqual(["Slack"]);
    expect(next.apiKeyConfigured).toBe(true);
  });

  it("clears a separately-owned event history", async () => {
    const clearHistory = vi.fn();
    const directory = await mkdtemp(join(tmpdir(), "here-settings-"));
    const settings = new SettingsStore({
      filePath: join(directory, "settings.json"),
      safeStorage,
      clearHistory,
    });
    await settings.clearHistory();
    expect(clearHistory).toHaveBeenCalledOnce();
  });

  it("refuses oversized secrets before writing them", async () => {
    const settings = await store();
    await expect(settings.setApiKey("x".repeat(8_193))).rejects.toThrow(
      /too long/,
    );
    expect((await settings.get()).apiKeyConfigured).toBe(false);
  });

  it("backs up corrupt settings and falls back with capture consent off", async () => {
    const directory = await mkdtemp(join(tmpdir(), "here-settings-"));
    const filePath = join(directory, "settings.json");
    await writeFile(filePath, "{not-json", "utf8");
    const settings = new SettingsStore({ filePath, safeStorage });
    expect((await settings.initialize()).captureConsent).toBe(false);
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith("settings.json.invalid-"),
      ),
    ).toBe(true);
  });
});
