import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function applyNativePermissions(backend, args, home = homedir()) {
  if (backend === "grok") {
    const flag = "--dangerously-skip-permissions";
    return args.includes(flag) ? [...args] : [...args, flag];
  }
  if (backend !== "agy" && backend !== "claude") return [...args];
  const file = backend === "agy"
    ? join(home, ".gemini/antigravity-cli/settings.json")
    : join(home, ".claude/settings.json");
  let settings;
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [...args];
    throw new Error(`Cannot read ${backend} permission settings: ${file}: ${error.message}`);
  }
  const bypass = backend === "agy"
    ? settings.toolPermission === "always-proceed"
    : settings.permissions?.defaultMode === "bypassPermissions";
  const flag = "--dangerously-skip-permissions";
  return bypass && !args.includes(flag) ? [...args, flag] : [...args];
}
