import { app } from "electron";

const timeoutMs = 5_000;

try {
  if (process.platform !== "win32")
    throw new Error("The native reader smoke test must run on Windows.");
  await app.whenReady();
  const reader = await import("get-windows");
  if (typeof reader.activeWindow !== "function")
    throw new Error("get-windows did not expose activeWindow().");
  const sample = await Promise.race([
    reader.activeWindow(),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("activeWindow() timed out.")), timeoutMs),
    ),
  ]);
  // Hosted runners may not have an interactive foreground window. Settling
  // without an ABI/load error is the smoke-test contract; never print titles.
  console.log(
    JSON.stringify({
      platform: process.platform,
      nativeReaderLoaded: true,
      foregroundWindowAvailable: Boolean(sample),
    }),
  );
  app.exit(0);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Windows reader smoke test failed.",
  );
  app.exit(1);
}
