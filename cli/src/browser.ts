import * as Effect from "effect/Effect";

export function openBrowser(url: string): Effect.Effect<void> {
  return Effect.sync(() => {
    if (process.env.SCRATCHWORK_NO_OPEN) return;
    try {
      const opener =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const openArgs = process.platform === "win32" ? ["/c", "start", "", url] : [opener, url];
      Bun.spawn(openArgs, { stdout: "ignore", stderr: "ignore" });
    } catch {
      /* opening the browser is best-effort */
    }
  });
}
