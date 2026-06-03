export type BrowserEngineMode = "gsd-browser" | "legacy" | "off";

const DEFAULT_BROWSER_ENGINE: BrowserEngineMode = "gsd-browser";

export function resolveBrowserEngineMode(env: NodeJS.ProcessEnv = process.env): BrowserEngineMode {
  const raw = env.GSD_BROWSER_ENGINE?.trim();
  if (!raw) return DEFAULT_BROWSER_ENGINE;

  const normalized = raw.toLowerCase();
  if (normalized === "gsd-browser" || normalized === "gsd_browser" || normalized === "gsdbrowser") {
    return "gsd-browser";
  }
  if (normalized === "legacy" || normalized === "playwright") return "legacy";
  if (normalized === "off" || normalized === "none" || normalized === "disabled" || normalized === "0" || normalized === "false") {
    return "off";
  }

  throw new Error(`Invalid GSD_BROWSER_ENGINE="${raw}". Expected "gsd-browser", "legacy", or "off".`);
}
