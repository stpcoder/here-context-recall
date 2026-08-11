import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  ContextCheckpoint,
  ModelReconstruction,
} from "../shared/contracts";
import type { SafeStorage } from "./settings-store";

const MAX_CHECKPOINTS = 12;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
});

const activityEventSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(["window-focus", "monitor-paused", "monitor-resumed"]),
  timestamp: z.number().int().positive(),
  appName: z.string().max(200).optional(),
  title: z.string().max(512).optional(),
  processId: z.number().int().nonnegative().optional(),
  windowId: z.string().max(200).optional(),
  bounds: boundsSchema.optional(),
  platform: z.enum([
    "aix",
    "android",
    "darwin",
    "freebsd",
    "haiku",
    "linux",
    "openbsd",
    "sunos",
    "win32",
    "cygwin",
    "netbsd",
  ]),
  titleRedacted: z.boolean().optional(),
});

const causalStepSchema = z.object({
  eventId: z.string().min(1).max(160),
  timestamp: z.number().int().positive(),
  label: z.string().min(1).max(800),
  role: z.enum(["context", "target", "interruption", "return"]),
});

const causalExplanationSchema = z.object({
  answer: z.string().min(1).max(1_200),
  origin: z.string().max(800).optional(),
  nextAction: z.string().max(800).optional(),
  chain: z.array(causalStepSchema).max(8),
  evidenceIds: z.array(z.string().min(1).max(160)).max(20),
  interrupted: z.boolean(),
});

const reconstructionSchema = z.object({
  summary: z.string().min(1).max(600),
  target: z.string().min(1).max(300),
  evidenceIds: z.array(z.string().min(1).max(160)).max(20),
  nextAction: z.string().max(300).optional(),
  source: z.enum(["model", "fallback"]),
});

const checkpointSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.number().int().positive(),
  event: activityEventSchema.optional(),
  evidence: z.array(activityEventSchema).max(20),
  explanation: causalExplanationSchema.optional(),
  reconstruction: reconstructionSchema.optional(),
  image: z
    .object({
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      dataUrl: z.string().startsWith("data:image/").max(8_000_000),
      width: z.number().int().positive().max(4_096),
      height: z.number().int().positive().max(4_096),
    })
    .optional(),
});

const checkpointFileSchema = z.object({
  version: z.literal(1),
  checkpoints: z.array(checkpointSchema).max(MAX_CHECKPOINTS),
});

export type CheckpointInput = Omit<ContextCheckpoint, "id" | "createdAt">;

export interface CheckpointStoreOptions {
  filePath: string;
  safeStorage: SafeStorage;
  now?: () => number;
}

/**
 * Explicit context checkpoints are the only timeline data persisted by Here.
 * The complete file, including any opt-in screenshot, is protected by the OS
 * key store before it touches disk.
 */
export class CheckpointStore {
  private readonly filePath: string;
  private readonly safeStorage: SafeStorage;
  private readonly now: () => number;
  private checkpoints: ContextCheckpoint[] = [];

  constructor(options: CheckpointStoreOptions) {
    this.filePath = options.filePath;
    this.safeStorage = options.safeStorage;
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<ContextCheckpoint[]> {
    this.checkpoints = this.prune(await this.read());
    return this.list();
  }

  list(): ContextCheckpoint[] {
    this.checkpoints = this.prune(this.checkpoints);
    return structuredClone(this.checkpoints);
  }

  latest(): ContextCheckpoint | undefined {
    return this.list()[0];
  }

  count(): number {
    return this.list().length;
  }

  async save(input: CheckpointInput): Promise<ContextCheckpoint> {
    this.requireEncryption();
    const checkpoint = checkpointSchema.parse({
      ...input,
      id: randomUUID(),
      createdAt: this.now(),
    });
    this.checkpoints = this.prune([checkpoint, ...this.checkpoints]).slice(
      0,
      MAX_CHECKPOINTS,
    );
    await this.write();
    return structuredClone(checkpoint);
  }

  async setReconstruction(
    id: string,
    reconstruction: ModelReconstruction,
  ): Promise<ContextCheckpoint | undefined> {
    const index = this.checkpoints.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    this.checkpoints[index] = checkpointSchema.parse({
      ...this.checkpoints[index],
      reconstruction,
    });
    await this.write();
    return structuredClone(this.checkpoints[index]);
  }

  async clear(): Promise<void> {
    this.checkpoints = [];
    try {
      await unlink(this.filePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async read(): Promise<ContextCheckpoint[]> {
    try {
      this.requireEncryption();
      const encrypted = await readFile(this.filePath);
      const plaintext = this.safeStorage.decryptString(encrypted);
      return checkpointFileSchema.parse(JSON.parse(plaintext)).checkpoints;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      try {
        await rename(this.filePath, `${this.filePath}.invalid-${this.now()}`);
      } catch {
        // Recovery is best-effort. Invalid encrypted data is never returned.
      }
      return [];
    }
  }

  private async write(): Promise<void> {
    this.requireEncryption();
    const payload = checkpointFileSchema.parse({
      version: 1,
      checkpoints: this.checkpoints,
    });
    const encrypted = this.safeStorage.encryptString(JSON.stringify(payload));
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private prune(items: ContextCheckpoint[]): ContextCheckpoint[] {
    const cutoff = this.now() - MAX_AGE_MS;
    return items
      .filter((item) => item.createdAt >= cutoff)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_CHECKPOINTS);
  }

  private requireEncryption(): void {
    if (!this.safeStorage.isEncryptionAvailable())
      throw new Error("OS encryption is unavailable; context was not saved.");
  }
}
