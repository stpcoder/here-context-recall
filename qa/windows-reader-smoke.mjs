const timeoutMs = 5_000;
const watchdog = setTimeout(() => {
  console.error("Windows reader smoke test process did not finish.");
  process.exit(1);
}, 15_000);

try {
  if (process.platform !== "win32")
    throw new Error("The native reader smoke test must run on Windows.");
  if (!process.versions.electron)
    throw new Error("The native reader smoke test must run with Electron.");
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
  clearTimeout(watchdog);
  process.exit(0);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Windows reader smoke test failed.",
  );
  clearTimeout(watchdog);
  process.exit(1);
}
