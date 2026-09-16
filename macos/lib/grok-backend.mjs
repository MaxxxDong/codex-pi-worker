import { existsSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const GROK_PROFILES = { efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "xhigh", defaultModel: "grok-4.6" };

export function selectGrok(args) {
  let model = GROK_PROFILES.defaultModel;
  let thinking = GROK_PROFILES.defaultEffort;
  const rest = [];
  const owned = new Set(["--cwd", "--session-id", "--resume", "--output-format", "--permission-mode", "--single", "-p", "--provider", "--rules"]);
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (owned.has(name)) throw new Error(`Subworker owns Grok option ${name}`);
    if (["--model", "--effort", "--thinking", "--reasoning-effort"].includes(name)) {
      const value = separator < 0 ? args[++i] : argument.slice(separator + 1);
      if (!value || value.startsWith("-")) throw new Error(`Missing value for ${name}`);
      if (name === "--model") model = value;
      else thinking = value;
    } else rest.push(argument);
  }
  if (!GROK_PROFILES.efforts.includes(thinking)) throw new Error(`Grok effort must be one of: ${GROK_PROFILES.efforts.join(", ")}`);
  return { args: rest, provider: "grok", model, thinking };
}

export function grokLauncher() {
  if (process.env.GROK_WORKER_LAUNCHER) return process.env.GROK_WORKER_LAUNCHER;
  const local = join(homedir(), ".local", "bin", "grok");
  return existsSync(local) ? local : "grok";
}

export function grokLaunchArgs({ args, prompt, mode, session, conversationId, workdir, systemPrompt }) {
  const bypass = args.includes("--dangerously-skip-permissions");
  return [
    ...args.filter((arg) => arg !== "--dangerously-skip-permissions"),
    "--model", mode.model, "--reasoning-effort", mode.thinking,
    "--permission-mode", bypass ? "bypassPermissions" : (mode.readOnly ? "plan" : "acceptEdits"),
    ...(bypass && !args.includes("--always-approve") ? ["--always-approve"] : []),
    "--output-format", "streaming-messages-json", "--include-partial-messages",
    "--cwd", workdir,
    ...(conversationId ? ["--resume", conversationId] : ["--session-id", session.id]),
    "--rules", systemPrompt, "-p", prompt,
  ];
}

export function createGrokSession(workdir) {
  return { id: randomUUID(), home: resolve(process.env.GROK_HOME || join(homedir(), ".grok")), cwd: realpathSync(workdir) };
}

export function grokSessionPath(session) {
  if (!session || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.id)) throw new Error("Invalid owned Grok session ID");
  return join(session.home, "sessions", encodeURIComponent(session.cwd), session.id);
}

export function cleanupGrokSession(session) {
  rmSync(grokSessionPath(session), { recursive: true, force: true });
}
