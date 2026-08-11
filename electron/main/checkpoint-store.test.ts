import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../shared/contracts";
import { CheckpointStore } from "./checkpoint-store";
import type { SafeStorage } from "./settings-store";

const safeStorage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) =>
    Buffer.from(
      Uint8Array.from(Buffer.from(value, "utf8"), (byte) => byte ^ 0xa7),
    ),
  decryptString: (value) =>
    Buffer.from(Uint8Array.from(value, (byte) => byte ^ 0xa7)).toString("utf8"),
};

function event(timestamp: number, title = "result.xlsx"): ActivityEvent {
  return {
    id: `event-${timestamp}`,
    kind: "window-focus",
    timestamp,
    appName: "Excel",
    title,
    platform: "darwin",
  };
}

describe("CheckpointStore", () => {
  it("persists only explicit checkpoints as OS-encrypted bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "here-checkpoint-"));
    const filePath = join(directory, "checkpoints.bin");
    const now = 1_786_406_400_000;
    const store = new CheckpointStore({
      filePath,
      safeStorage,
      now: () => now,
    });
    await store.initialize();
    const saved = await store.save({
      event: event(now),
      evidence: [event(now)],
      image: {
        mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,aGVyZQ==",
        width: 2,
        height: 2,
      },
    });

    const bytes = await readFile(filePath);
    expect(bytes.toString("utf8")).not.toContain("result.xlsx");
    expect(store.latest()).toMatchObject({ id: saved.id, createdAt: now });

    const reloaded = new CheckpointStore({
      filePath,
      safeStorage,
      now: () => now,
    });
    await reloaded.initialize();
    expect(reloaded.latest()?.event?.title).toBe("result.xlsx");
    expect(reloaded.latest()?.image?.dataUrl).toContain("aGVyZQ==");
  });

  it("keeps at most twelve checkpoints and prunes those older than seven days", async () => {
    const directory = await mkdtemp(join(tmpdir(), "here-checkpoint-"));
    const filePath = join(directory, "checkpoints.bin");
    let now = 1_786_406_400_000;
    const store = new CheckpointStore({
      filePath,
      safeStorage,
      now: () => now,
    });
    await store.initialize();
    for (let index = 0; index < 14; index += 1) {
      await store.save({
        event: event(now, `result-${index}.xlsx`),
        evidence: [event(now, `result-${index}.xlsx`)],
      });
      now += 1_000;
    }
    expect(store.count()).toBe(12);
    expect(store.latest()?.event?.title).toBe("result-13.xlsx");

    now += 8 * 24 * 60 * 60 * 1_000;
    expect(store.list()).toEqual([]);
  });

  it("backs up unreadable data and clear removes the encrypted file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "here-checkpoint-"));
    const filePath = join(directory, "checkpoints.bin");
    await writeFile(filePath, "not encrypted checkpoint data");
    const store = new CheckpointStore({ filePath, safeStorage });
    await expect(store.initialize()).resolves.toEqual([]);
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith("checkpoints.bin.invalid-"),
      ),
    ).toBe(true);

    await store.save({ event: event(Date.now()), evidence: [] });
    await store.clear();
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to persist when OS encryption is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "here-checkpoint-"));
    const unavailable = { ...safeStorage, isEncryptionAvailable: () => false };
    const store = new CheckpointStore({
      filePath: join(directory, "checkpoints.bin"),
      safeStorage: unavailable,
    });
    await expect(
      store.save({ event: event(Date.now()), evidence: [] }),
    ).rejects.toThrow(/OS encryption/);
  });
});
