#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createStderrScan, createStdoutScan, isCorruptedJson } from "./stream-scan.mjs";
import { buildRetryGuidance, nextRetryCount, parseRetryAttempt } from "./retry-policy.mjs";
import { fileURLToPath } from "node:url";
import { AGY_PROFILES, agyLaunchArgs, agyLauncher, selectAgy, summarizeAgyStream } from "./agy-backend.mjs";
import { CLAUDE_PROFILES, claudeLaunchArgs, claudeLauncher, selectClaude, summarizeClaudeStream } from "./claude-backend.mjs";
import { diagnoseRuns } from "./diagnose.mjs";
import { applyNativePermissions } from "./native-permissions.mjs";
import { GROK_PROFILES, grokLauncher, grokLaunchArgs, selectGrok, createGrokSession, cleanupGrokSession } from "./grok-backend.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const FALLBACK_MS = 15_000;
const PROGRESS_WRITE_MS = 250;
const DEFAULT_STARTUP_ATTENTION_SECONDS = 60;
const DEFAULT_SILENT_REMINDER_SECONDS = 600;
const DEFAULT_PROGRESS_REMINDER_SECONDS = 600;
const ATTENTION_LIMIT = 8;
const SETTLE_GRACE_SECONDS = 8;
const DEFAULT_CONSUMER = "default";
const WORKER_VERSION = "0.4.1";
const WORKER_BRAND = "subworker";
const ENV_PREFIX = "SUBWORKER_";
const LEGACY_ENV_PREFIX = "PI_WORKER_";
function prefixed(name) { return ENV_PREFIX + name; }
function legacy(name) { return LEGACY_ENV_PREFIX + name; }
// PI_WORKER_* remains a compatibility input; SUBWORKER_* is the canonical spelling.
function envVar(name) {
  return process.env[prefixed(name)] ?? process.env[legacy(name)];
}
const PHYSICAL_STATE_ROOT = process.platform === "darwin"
  ? join(homedir(), "Library", "Application Support", "pi-worker", "runs")
  : join(homedir(), ".local", "state", "pi-worker", "runs");
// Public storage path stays pi-worker/runs: existing runs, worktrees and session
// directories hold absolute paths that must keep resolving.
const DEFAULT_ROOT = envVar("STATE_ROOT") ?? PHYSICAL_STATE_ROOT;
const CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024;
const CACHE_STALE_MS = 90 * 24 * 60 * 60 * 1000;
const CACHE_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_ACTION_LIMIT = 12;
const FAILURE_TAIL_BYTES = 64 * 1024;
const TOOL_ERROR_BYTES = 2 * 1024;
const STEER_MAX_BYTES = 16 * 1024;
const BASE_TOOLS = ["read", "bash", "edit", "write", "grep", "ls", "web_search"];
const READ_TOOLS = ["read", "bash", "grep", "ls", "web_search"];
const READ_ONLY_PROMPT = "This is a read-only task. Do not modify repository files. Use bash only for inspection or commands known not to write project files.";
const AGENT_PROFILE_FILES = ["auth.json", "models.json", "models-store.json", "settings.json"];
const OPTIONAL_PACKAGES = ["@upstash/context7-pi", "context-mode", "pi-lens", "pi-playwright"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PROFILES = new Map([
  ["deepseek/deepseek-v4-flash", { defaultThinking: "max" }],
  ["ahzm/glm-5.3", { defaultThinking: "max" }],
  ["ahzm/glm-5.3-flash", { defaultThinking: "max" }],
  ["commandcode/z-ai/glm-5.3-flash", { defaultThinking: "max" }],
  ["commandcode/deepseek/deepseek-v4-flash", { defaultThinking: "max" }],
  ["commandcode/google/gemini-3.7-flash", { defaultThinking: "high" }],
  ["commandcode/Qwen/Qwen3.8-Flash", { defaultThinking: "max" }],
  ["commandcode/Qwen/Qwen3.8-Max", { defaultThinking: "xhigh" }],
  ["xai/grok-4.5", { defaultThinking: "high" }],
  ["xai/grok-4.6", { defaultThinking: "high" }],
]);
const ATTENTION_PATTERNS = [
  ["authentication", /(?:\b401\b|\b403\b|unauthori[sz]ed|invalid (?:api )?key|authentication failed|invalid_grant|oauth token refresh failed)/i],
  ["request_rejected", /(?:\b400\b|data[_ ]inspection[_ ]failed|inappropriate content|invalid_request_error)/i],
  ["rate_limit", /(?:\b429\b|rate[ -]?limit|too many requests)/i],
  ["provider_5xx", /(?:\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway timeout)/i],
  ["permission_denied", /(?:permission.*(?:denied|cannot prompt)|auto-denied|denied\s+\d*\s*required action)/i],
  ["reasoning_ignored", /(?:(?:reasoning|thinking).*(?:ignored|unsupported|not supported)|(?:ignored|unsupported).*(?:reasoning|thinking))/i],
  ["transport", /(?:broken pipe|ECONNRESET|socket hang up|connection reset|connection error|unexpected eof|\bEOF\b|stream (?:ended before a terminal response event|was interrupted)|upstream stream ended before terminal chunk|fetch failed)/i],
];

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const flags = separator < 0 ? argv : argv.slice(0, separator);
  const passthrough = separator < 0 ? [] : argv.slice(separator + 1);
  const options = new Map();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (!flag.startsWith("--")) fail(`unexpected argument: ${flag}`);
    const equal = flag.indexOf("=");
    const name = equal < 0 ? flag.slice(2) : flag.slice(2, equal);
    if (equal < 0 && ["live", "full"].includes(name)) {
      options.set(name, [...(options.get(name) ?? []), "true"]);
      continue;
    }
    const value = equal < 0 ? flags[++index] : flag.slice(equal + 1);
    if (!value || value.startsWith("--")) fail(`missing value for --${name}`);
    options.set(name, [...(options.get(name) ?? []), value]);
  }
  return { options, passthrough };
}

function usage() {
  return `subworker commands:
  dispatch --run-id ID [--backend pi|agy|claude|grok] [--mode read|write|in-place] [--source DIR|--workdir DIR]
           [--capability docs|lens|context|browser] [--live] [--idle-timeout SECONDS]
           [--hard-timeout SECONDS] [--startup-attention SECONDS] [--silent-reminder SECONDS] [--progress-reminder SECONDS] -- BACKEND_ARGS PROMPT
  continue --run-id ID [--live] [--idle-timeout SECONDS] [--startup-attention SECONDS] [--silent-reminder SECONDS] [--progress-reminder SECONDS] -- PROMPT
  steer --run-id ID [--timeout SECONDS] -- MESSAGE
  cancel --run-id ID [--run-id ID...] [--reason TEXT] [--timeout SECONDS]
  wait --run-id ID [--run-id ID...] [--consumer NAME] [--timeout SECONDS] [--full]
  cleanup --reviewed yes --run-id ID [--run-id ID...]
  status --run-id ID [--run-id ID...]
  diagnose --run-id ID [--run-id ID...]
  cache-status
  profiles`;
}

function one(options, name, fallback = undefined) {
  return options.get(name)?.at(-1) ?? fallback;
}

function stateRoot(options) {
  return resolve(one(options, "state-root", process.env[prefixed("STATE_ROOT")] ?? process.env[legacy("STATE_ROOT")] ?? DEFAULT_ROOT));
}

// SUBWORKER_* is canonical; PI_CODING_AGENT_DIR is a Pi-owned variable that must
// keep its name and precedence for extensions, capabilities and Playwright.
function agentSourceRoot() {
  return resolve(envVar("AGENT_SOURCE") ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
}

function launcherOverride() {
  return process.env[prefixed("LAUNCHER")] ?? process.env[legacy("LAUNCHER")] ?? null;
}

// Backend CLI versions are not derivable from the Pi agent profile package.
// Recording a guessed value for Agy/Claude would be wrong; only a confirmed
// version may be recorded, so this stays null. No per-invocation CLI --version
// scan is added; the value is fixed at dispatch time.
function backendVersion() {
  return null;
}

// Dispatcher identity is recorded at dispatch time from confirmed environment
// sources only. PI_SESSION_ID is set by the pi CLI for its own session dir;
// CODEX_THREAD_ID identifies the scheduling Codex thread; the Claude Code
// variables only apply to that backend's runs.
function dispatcherFacts() {
  const facts = {};
  if (process.env.CODEX_THREAD_ID) facts.threadId = process.env.CODEX_THREAD_ID;
  if (process.env.PI_SESSION_ID) facts.piSessionId = process.env.PI_SESSION_ID;
  if (process.env.CLAUDE_CODE_SESSION_ID) facts.claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (process.env.CLAUDE_PROJECT_DIR) facts.claudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  const piBin = envVar("PI_BIN");
  if (piBin) facts.piBin = piBin;
  return facts;
}

function validateRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId ?? "")) {
    fail("--run-id must contain only letters, digits, dot, underscore, or hyphen");
  }
  return runId;
}

function runDirectory(root, runId) {
  return join(root, validateRunId(runId));
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function withRunLock(directory, action) {
  const path = join(directory, ".lifecycle.lock");
  let handle;
  try {
    handle = openSync(path, "wx", 0o600);
  } catch {
    const owner = readJson(path);
    if (!owner?.pid || processAlive(owner.pid)) fail(`run lifecycle is busy: ${directory}`, 3);
    try { unlinkSync(path); } catch {}
    try { handle = openSync(path, "wx", 0o600); } catch { fail(`run lifecycle is busy: ${directory}`, 3); }
  }
  writeFileSync(handle, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
  try {
    return action();
  } finally {
    closeSync(handle);
    try { unlinkSync(path); } catch {}
  }
}

function extractPrompt(piArgs) {
  const prompt = piArgs.at(-1);
  if (!prompt || prompt.startsWith("--")) fail("dispatch requires one prompt as the final backend argument");
  return { prompt, args: piArgs.slice(0, -1) };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processGroupAlive(pid) {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function piOptionValues(piArgs, name) {
  const flag = `--${name}`;
  const values = [];
  piArgs.forEach((argument, index) => {
    if (argument.startsWith(`${flag}=`)) values.push(argument.slice(flag.length + 1));
    else if (argument === flag && piArgs[index + 1] && !piArgs[index + 1].startsWith("--")) {
      values.push(piArgs[index + 1]);
    }
  });
  return values;
}

function replacePiOption(piArgs, name, value) {
  const flag = `--${name}`;
  const args = [];
  for (let index = 0; index < piArgs.length; index += 1) {
    const argument = piArgs[index];
    if (argument.startsWith(`${flag}=`)) continue;
    if (argument === flag) {
      if (piArgs[index + 1] && !piArgs[index + 1].startsWith("--")) index += 1;
      continue;
    }
    args.push(argument);
  }
  return [flag, value, ...args];
}

function providerExtensionArgs(provider) {
  if (!/^[A-Za-z0-9._-]+$/.test(provider)) return [];
  const source = agentSourceRoot();
  const extension = ["ts", "js", "mjs"].map((suffix) => join(source, "extensions", `${provider}.${suffix}`)).find(existsSync);
  return extension ? ["--extension", extension] : [];
}

function applyDispatchProfile(piArgs) {
  if (piArgs.some((argument) => /^--(?:session|session-id|session-dir|continue|resume|fork)(?:=|$)/.test(argument))) {
    fail("Pi Worker owns its managed session; use the continue command for another turn");
  }
  const provider = piOptionValues(piArgs, "provider").at(-1);
  const model = piOptionValues(piArgs, "model").at(-1);
  if (!provider || !model) fail("dispatch requires explicit --provider, --model");
  const key = `${provider}/${model}`;
  const profile = PROFILES.get(key);
  const supplied = piOptionValues(piArgs, "thinking");
  const requestedThinking = supplied.at(-1) ?? profile?.defaultThinking;
  if (!requestedThinking) fail(`unknown Pi Worker profile ${key} requires explicit --thinking`);
  if (!THINKING_LEVELS.includes(requestedThinking)) fail(`thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  const thinking = requestedThinking;
  return {
    args: [...providerExtensionArgs(provider), ...(supplied.length > 0 ? piArgs : ["--thinking", profile.defaultThinking, ...piArgs])],
    provider,
    model,
    thinking,
  };
}

function capabilityProfile(name) {
  const agent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const npm = join(agent, "npm", "node_modules");
  const profiles = {
    docs: {
      resources: [
        ["--extension", join(npm, "@upstash", "context7-pi", "extensions", "context7.ts")],
        ["--skill", join(npm, "@upstash", "context7-pi", "skills", "context7-docs", "SKILL.md")],
      ],
      tools: ["resolve-library-id", "query-docs"],
    },
    lens: {
      resources: [
        ["--extension", join(npm, "pi-lens", "dist", "index.js")],
        ["--skill", join(npm, "pi-lens", "skills")],
      ],
      tools: ["lens_diagnostics", "lsp_diagnostics", "read_enclosing", "read_symbol", "symbol_search"],
    },
    context: {
      resources: [
        ["--extension", join(npm, "context-mode", "build", "adapters", "pi", "extension.js")],
        ["--skill", join(npm, "context-mode", "skills")],
      ],
      tools: ["ctx_execute", "ctx_execute_file", "ctx_batch_execute", "ctx_search"],
    },
    browser: {
      resources: [["--skill", join(npm, "pi-playwright", "skills", "playwright-browser", "SKILL.md")]],
      tools: [],
    },
  };
  return profiles[name] ?? null;
}

function applyCapabilities(piArgs, names, baseTools = BASE_TOOLS) {
  const args = [...piArgs];
  const tools = new Set(baseTools);
  for (const name of names) {
    const profile = capabilityProfile(name);
    if (!profile) fail(`unsupported capability: ${name}; use docs, lens, context, or browser`);
    for (const [, path] of profile.resources) {
      if (!existsSync(path)) fail(`capability ${name} is not installed: ${path}`);
    }
    args.unshift(...profile.resources.flat());
    profile.tools.forEach((tool) => tools.add(tool));
  }
  return ["--tools", [...tools].join(","), ...args];
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== "object") return total;
  const next = { ...total };
  for (const [name, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) next[name] = (next[name] ?? 0) + value;
    else if (value && typeof value === "object" && !Array.isArray(value)) next[name] = addUsage(next[name] ?? {}, value);
  }
  return next;
}

function redactText(value) {
  return String(value ?? "")
    .replace(/((?:authorization|api[_-]?key|token|secret|cookie)\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|nb)_[A-Za-z0-9_-]{16,}\b|\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
}

function classifyAttention(value) {
  const text = String(value ?? "");
  return ATTENTION_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function runGit(cwd, args, { input = undefined, binary = false, allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    input,
    encoding: binary ? null : "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "git command failed").toString().trim();
    throw new Error(detail);
  }
  return result;
}

function copyUntracked(sourceRoot, worktree) {
  const output = runGit(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"], { binary: true }).stdout;
  for (const name of output.toString("utf8").split("\0").filter(Boolean)) {
    if (isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw new Error(`unsafe untracked path: ${name}`);
    const source = join(sourceRoot, name);
    const target = join(worktree, name);
    mkdirSync(dirname(target), { recursive: true });
    const info = lstatSync(source);
    if (info.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else if (info.isFile()) copyFileSync(source, target);
  }
}

function createManagedWorktree(source, directory) {
  const sourceRoot = resolve(runGit(resolve(source), ["rev-parse", "--show-toplevel"]).stdout.trim());
  const baseCommit = runGit(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
  const worktree = join(directory, "worktree");
  runGit(sourceRoot, ["worktree", "add", "--detach", worktree, baseCommit]);
  try {
    const dirtyPatch = runGit(sourceRoot, ["diff", "--binary", "HEAD"], { binary: true }).stdout;
    if (dirtyPatch.length > 0) runGit(worktree, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: dirtyPatch });
    copyUntracked(sourceRoot, worktree);
    runGit(worktree, ["add", "-A"]);
    const baselineTree = runGit(worktree, ["write-tree"]).stdout.trim();
    runGit(worktree, ["reset", "--mixed", "HEAD"]);
    if (runGit(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim() !== baseCommit) {
      throw new Error("source HEAD changed while creating the worktree; dispatch again");
    }
    return { sourceRoot, worktree, baseCommit, baselineTree };
  } catch (error) {
    runGit(sourceRoot, ["worktree", "remove", "--force", worktree], { allowFailure: true });
    throw error;
  }
}

function rebuildableArtifactRoot(name) {
  const parts = name.split("/");
  const index = parts.findIndex((part) =>
    ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".venv", "venv"].includes(part)
    || part.endsWith(".egg-info"));
  if (index >= 0) return parts.slice(0, index + 1).join("/");
  if (/\.(?:pyc|pyo)$/.test(name) || parts.at(-1) === ".coverage") return name;
  return null;
}

function discardRebuildableArtifacts(result) {
  const changed = runGit(result.workdir, ["diff", "--cached", "--name-only", "-z", result.baselineTree], { binary: true })
    .stdout.toString("utf8").split("\0").filter(Boolean);
  const artifacts = new Set(changed.map(rebuildableArtifactRoot).filter(Boolean));
  for (const name of artifacts) {
    const object = result.baselineTree + ":" + name;
    const existed = runGit(result.workdir, ["cat-file", "-e", object], { allowFailure: true }).status === 0;
    runGit(result.workdir, ["reset", result.baselineTree, "--", name]);
    rmSync(join(result.workdir, name), { recursive: true, force: true });
    if (existed) runGit(result.workdir, ["checkout", result.baselineTree, "--", name]);
  }
}

function capturePatch(result, directory) {
  if (!result.managedWorktree) return { patchPath: null, patchBytes: 0 };
  runGit(result.workdir, ["add", "-A"]);
  discardRebuildableArtifacts(result);
  const patch = runGit(result.workdir, ["diff", "--binary", "--cached", result.baselineTree], { binary: true }).stdout;
  runGit(result.workdir, ["reset", "--mixed", "HEAD"]);
  if (patch.length === 0) return { patchPath: null, patchBytes: 0 };
  const patchPath = join(directory, "changes.patch");
  writeFileSync(patchPath, patch, { mode: 0o600 });
  return { patchPath, patchBytes: patch.length };
}

function removeManagedWorktree(result, directory) {
  if (!result?.managedWorktree) return { removed: false, errors: [] };
  const expected = resolve(directory, "worktree");
  const worktree = resolve(result.workdir);
  if (worktree !== expected) return { removed: false, errors: [`refusing unmanaged path: ${worktree}`] };
  const errors = [];
  const removal = runGit(result.sourceRoot, ["worktree", "remove", "--force", worktree], { allowFailure: true });
  if (removal.status !== 0) errors.push((removal.stderr || removal.stdout).toString().trim());
  if (existsSync(worktree)) {
    try {
      rmSync(worktree, { recursive: true, force: true });
    } catch (error) {
      errors.push(error.message);
    }
  }
  runGit(result.sourceRoot, ["worktree", "prune"], { allowFailure: true });
  return { removed: !existsSync(worktree), errors: errors.filter(Boolean) };
}

function messageText(message) {
  return (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

async function summarizeStream(stream, onActivity, onAttention, onResponse = () => {}, onSettled = () => {}) {
  const summary = { settled: false, lastAssistant: null, usage: {}, assistantCalls: 0, tools: [], playwrightUsed: false, consecutiveToolErrors: 0, lastToolErrorKey: null, providerRetryCount: null };
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const scan = createStdoutScan({ classifyAttention });
  for await (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Malformed output cannot prove completion, but does not need permanent storage.
      const hit = scan.noteLine(line);
      if (hit) onAttention(hit.category, hit.detail);
      if (isCorruptedJson(line)) {
        throw new Error(`Corrupted protocol JSON: malformed JSON frame; line: ${String(line ?? "").trim().slice(0, 200)}`);
      }
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(`Corrupted protocol frame: expected non-null object, got ${event === null ? "null" : Array.isArray(event) ? "array" : typeof event}`);
    }
    scan.noteSuccess();
    onActivity(event);
    if (event.type === "agent_settled") {
      summary.settled = true;
      onSettled();
    }
    if (event.type === "tool_execution_start" && event.toolName === "bash") {
      summary.playwrightUsed ||= /(?:pi-playwright|playwright-browser|pw\.js)/.test(JSON.stringify(event));
    }
    if (event.type === "tool_execution_end") {
      const error = Boolean(event.isError ?? event.result?.isError);
      const name = event.toolName ?? null;
      let tool = summary.tools.find((entry) => entry.name === name);
      if (!tool) {
        tool = { name, count: 0, errorCount: 0 };
        summary.tools.push(tool);
      }
      tool.count += 1;
      if (error) {
        tool.errorCount += 1;
        tool.lastError = redactText(JSON.stringify(event.result ?? event.error ?? "tool failed")).slice(0, TOOL_ERROR_BYTES);
        const errorKey = String(name) + "\\0" + tool.lastError;
        summary.consecutiveToolErrors = summary.lastToolErrorKey === errorKey
          ? summary.consecutiveToolErrors + 1
          : 1;
        summary.lastToolErrorKey = errorKey;
      } else {
        summary.consecutiveToolErrors = 0;
        summary.lastToolErrorKey = null;
      }
      if (summary.consecutiveToolErrors >= 3) onAttention("repeated_tool_errors", tool.lastError);
    }
    if (event.type === "auto_retry_start") {
      summary.providerRetryCount = nextRetryCount(summary.providerRetryCount, parseRetryAttempt(event));
      onAttention("provider_retry", JSON.stringify(event));
    }
    if (event.type === "auto_retry_end" && event.success === false) onAttention("provider_retry_failed", JSON.stringify(event));
    if (event.type === "extension_error") onAttention("extension_error", JSON.stringify(event));
    if (event.type === "compaction_end" && !event.result && !event.aborted) onAttention("compaction_error", JSON.stringify(event));
    if (event.type === "response") onResponse(event);
    if (event.type === "message_end" && event.message?.role === "assistant") {
      summary.usage = addUsage(summary.usage, event.message.usage);
      summary.assistantCalls += 1;
      summary.lastAssistant = {
        provider: event.message.provider ?? null,
        model: event.message.model ?? null,
        stopReason: event.message.stopReason ?? null,
        error: event.message.errorMessage ?? null,
        usage: event.message.usage ?? null,
        text: messageText(event.message),
      };
      const attention = classifyAttention(event.message.errorMessage);
      if (attention) onAttention(attention, event.message.errorMessage);
    }
  }
  return summary;
}

function collectTail(stream, onActivity, onAttention) {
  return new Promise((resolveTail, rejectTail) => {
    let tail = "";
    const scan = createStderrScan({ classifyAttention });
    stream.setEncoding("utf8");
    stream.on("error", (error) => rejectTail(error));
    stream.on("data", (chunk) => {
      try {
        onActivity(null);
        tail = (tail + chunk).slice(-FAILURE_TAIL_BYTES);
        const hit = scan.push(chunk);
        if (hit) onAttention(hit.category, hit.detail);
      } catch (error) {
        rejectTail(error);
      }
    });
    stream.on("end", () => resolveTail(tail.trim()));
  });
}

function eventDirectory(directory) {
  const key = createHash("sha256").update(resolve(directory)).digest("hex");
  // Keep the physical event path: legacy default receipts and live waiters of
  // running runs live here, so renaming the directory would strand them.
  return join(tmpdir(), "pi-worker-events", key);
}

// Receipt identity and scope live in exactly one place so that readiness
// checks (pendingAttention) and atomic claims (claimAttention) always agree on
// the same file:
//  - The default consumer maps to the legacy global receipt (no suffix), so
//    old waiters and the default path share one delivery and old receipts keep
//    working. A later switch of the default resolution cannot strand either.
//  - Any explicitly named consumer gets its own suffixed receipt namespace and
//    is never shadowed by the legacy default receipt.
//  - New attention records carry a content fingerprint; the receipt key uses
//    both detectedAt and the fingerprint so two alerts of the same category
//    detected within the same millisecond with different details get distinct
//    receipts, while recurring alerts in subsequent turns remain independently
//    consumable. Records written before fingerprints existed keep their legacy
//    detectedAt+category key so past receipts stay valid.
function attentionReceipt(directory, attention, consumer = null) {
  const scope = consumer === DEFAULT_CONSUMER ? null : consumer;
  const keyMaterial = attention?.fingerprint
    ? String(attention.detectedAt ?? "") + "\0" + String(attention.fingerprint)
    : String(attention.detectedAt ?? "") + "\\0" + String(attention.category ?? "");
  const key = createHash("sha256").update(keyMaterial).digest("hex");
  return join(eventDirectory(directory), "attention-" + key + (scope ? "-" + createHash("sha256").update(scope).digest("hex").slice(0, 16) : "") + ".json");
}

// Atomic wx claim: exactly one concurrent waiter with the same consumer wins;
// EEXIST means another waiter already claimed it (a regular receipt file is in
// place). Any other failure - including an EEXIST whose target is a directory
// or a broken link - is a real IO fault and must surface, never be mistaken
// for an already-notified delivery.
function claimAttention(directory, attention, consumer) {
  const receipt = attentionReceipt(directory, attention, consumer);
  mkdirSync(eventDirectory(directory), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = openSync(receipt, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      let existing = null;
      try {
        existing = statSync(receipt);
      } catch {}
      if (existing?.isFile()) return null;
      throw new Error(`receipt path is not a claimable file: ${receipt}`);
    }
    throw error;
  }
  try {
    writeFileSync(handle, `${JSON.stringify({ consumer, claimedAt: new Date().toISOString(), delivered: false })}\n`);
  } finally {
    closeSync(handle);
  }
  return receipt;
}

function consumerName(value) {
  const candidate = String(value ?? "").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidate)) return candidate;
  if (!candidate) return null;
  fail(`--consumer must be letters, digits, dot, underscore, or hyphen: ${candidate}`);
}

function attentionEvents(value) {
  if (Array.isArray(value?.events)) return value.events;
  return value?.category ? [value] : [];
}

function attentionFingerprint(category, detail) {
  return createHash("sha256").update(String(category) + "\0" + String(detail)).digest("hex");
}

// A fingerprint distinguishes two same-category alerts that share a detection
// millisecond. Records that predate fingerprints have none and keep their
// legacy receipt path; only new records carry one.
function fingerprintOf(entry) {
  return entry?.fingerprint ?? attentionFingerprint(String(entry?.category ?? ""), String(entry?.detail ?? ""));
}

function notifyWaiter(directory, consumer = null) {
  const waiters = eventDirectory(directory);
  if (!existsSync(waiters)) return;
  for (const name of readdirSync(waiters).filter((entry) => /^\d+\.json$/.test(entry))) {
    const path = join(waiters, name);
    const waiter = readJson(path);
    if (!processAlive(waiter?.pid)) {
      try { unlinkSync(path); } catch {}
      continue;
    }
    if (consumer && waiter?.consumer && waiter.consumer !== consumer) continue;
    try {
      process.kill(waiter.pid, "SIGUSR1");
    } catch {
      // result.json is durable; the fallback check still sees it.
    }
  }
}

function cacheCandidates() {
  const home = homedir();
  if (process.env[prefixed("TEST_CACHE_ROOTS")] || process.env[legacy("TEST_CACHE_ROOTS")]) {
    return String(envVar("TEST_CACHE_ROOTS")).split(delimiter).map((path) => resolve(path));
  }
  return [
    join(home, ".cache", "uv"),
    join(home, "Library", "Caches", "uv"),
    join(home, ".npm"),
    join(home, "Library", "Caches", "pip"),
    join(home, ".cache", "pip"),
    join(home, "Library", "pnpm", "store"),
    join(home, ".cache", "pypoetry"),
    join(home, "Library", "Caches", "pypoetry"),
    join(home, ".pi-lens"),
  ].map((path) => resolve(path)).filter((path, index, all) => all.indexOf(path) === index);
}

function cacheEnvironment() {
  const candidates = cacheCandidates();
  const find = (...suffixes) => candidates.find((path) => suffixes.some((suffix) => path.endsWith(suffix)) && existsSync(path));
  return Object.fromEntries(Object.entries({
    UV_CACHE_DIR: find("/.cache/uv", "/Library/Caches/uv"),
    npm_config_cache: find("/.npm"),
    PIP_CACHE_DIR: find("/Caches/pip", "/.cache/pip"),
    POETRY_CACHE_DIR: find("/.cache/pypoetry", "/Caches/pypoetry"),
  }).filter(([, value]) => value));
}

function cacheSize(path) {
  if (!existsSync(path)) return 0;
  const result = spawnSync("du", ["-sk", path], { encoding: "utf8" });
  return result.status === 0 ? Number.parseInt(result.stdout, 10) * 1024 : 0;
}

function cacheReport() {
  const entries = cacheCandidates().filter(existsSync).map((path) => ({ path, bytes: cacheSize(path) }));
  return {
    maxBytes: (process.env[prefixed("TEST_CACHE_ROOTS")] || process.env[legacy("TEST_CACHE_ROOTS")])
      ? Number(envVar("CACHE_MAX_BYTES") ?? CACHE_MAX_BYTES)
      : CACHE_MAX_BYTES,
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    entries,
  };
}

function cacheFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = statSync(path);
        files.push({ path, bytes: info.size, lastUsedMs: Math.max(info.atimeMs, info.mtimeMs) });
      } catch {}
    }
  }
  return files;
}

function activeWorkers(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    if (name.startsWith(".")) return [];
    const result = readJson(join(root, name, "result.json"));
    return result && !terminal(result) && (processAlive(result.supervisorPid) || processAlive(result.childPid)) ? [name] : [];
  });
}

function recordCacheAction(actions, actionSummary, action) {
  actionSummary.attempted += 1;
  if (action.exitCode === 0) actionSummary.succeeded += 1;
  else actionSummary.failed += 1;
  if (actions.length < CACHE_ACTION_LIMIT) actions.push(action);
}

function pruneCacheFiles(before, actions, actionSummary) {
  const cutoff = Date.now() - CACHE_STALE_MS;
  const files = cacheCandidates().flatMap(cacheFiles).sort((left, right) => left.lastUsedMs - right.lastUsedMs);
  let estimatedBytes = before.totalBytes;
  for (const file of files) {
    if (file.lastUsedMs >= cutoff && estimatedBytes <= before.maxBytes) break;
    try {
      unlinkSync(file.path);
      estimatedBytes = Math.max(0, estimatedBytes - file.bytes);
      recordCacheAction(actions, actionSummary, { command: "cache file remove", path: file.path, bytes: file.bytes, stale: file.lastUsedMs < cutoff, exitCode: 0 });
    } catch (error) {
      recordCacheAction(actions, actionSummary, { command: "cache file remove", path: file.path, bytes: file.bytes, exitCode: 1, error: error.message });
    }
  }
}

function compactCacheReceipt(receipt) {
  if (!Array.isArray(receipt?.actions) || receipt.actions.length <= CACHE_ACTION_LIMIT) return receipt;
  const actionSummary = receipt.actionSummary ?? receipt.actions.reduce((summary, action) => {
    summary.attempted += 1;
    if (action.exitCode === 0) summary.succeeded += 1;
    else summary.failed += 1;
    return summary;
  }, { attempted: 0, succeeded: 0, failed: 0 });
  return {
    ...receipt,
    actions: receipt.actions.slice(0, CACHE_ACTION_LIMIT),
    actionSummary: { ...actionSummary, omitted: receipt.actions.length - CACHE_ACTION_LIMIT },
  };
}

function cacheGc(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.env.CODEX_SANDBOX === "seatbelt" && !process.env[prefixed("TEST_CACHE_ROOTS")] && !process.env[legacy("TEST_CACHE_ROOTS")]) {
    return { skipped: "shared cache GC requires host filesystem permissions", ...cacheReport() };
  }
  const receiptPath = join(root, ".cache-gc.json");
  const previous = readJson(receiptPath);
  if (previous && Date.now() - Date.parse(previous.checkedAt) < CACHE_GC_INTERVAL_MS) {
    return { ...compactCacheReceipt(previous), skipped: "checked within the last day" };
  }
  const lock = join(root, ".cache-gc.lock");
  let handle;
  try {
    handle = openSync(lock, "wx", 0o600);
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > 60 * 60 * 1000) {
        unlinkSync(lock);
        handle = openSync(lock, "wx", 0o600);
      }
    } catch {}
    if (handle === undefined) return { skipped: "already running", ...cacheReport() };
  }
  try {
    const active = activeWorkers(root);
    if (active.length > 0) return { skipped: "workers active", active, ...cacheReport() };
    const before = cacheReport();
    const sharedEnv = cacheEnvironment();
    const env = { ...process.env, ...sharedEnv };
    const pnpmStore = cacheCandidates().find((path) => path.endsWith("/pnpm/store") && existsSync(path));
    const actions = [];
    const actionSummary = { attempted: 0, succeeded: 0, failed: 0 };
    pruneCacheFiles(before, actions, actionSummary);
    if (actionSummary.attempted === 0 && before.totalBytes <= before.maxBytes) {
      const outcome = { checkedAt: new Date().toISOString(), before, after: before, actions, actionSummary, overLimit: false };
      atomicJson(receiptPath, outcome);
      return outcome;
    }
    const commands = [
      ...(sharedEnv.UV_CACHE_DIR ? [["uv", ["cache", "prune"]]] : []),
      ...(pnpmStore ? [["pnpm", ["--store-dir", pnpmStore, "store", "prune"]]] : []),
      ...(sharedEnv.npm_config_cache ? [["npm", ["cache", "verify"]]] : []),
    ];
    for (const [command, args] of commands) {
      const result = spawnSync(command, args, { env, encoding: "utf8" });
      recordCacheAction(actions, actionSummary, { command: `${command} ${args.join(" ")}`, exitCode: result.status });
    }
    const after = cacheReport();
    const outcome = {
      checkedAt: new Date().toISOString(),
      before,
      after,
      actions,
      actionSummary: { ...actionSummary, omitted: Math.max(0, actionSummary.attempted - actions.length) },
      overLimit: after.totalBytes > after.maxBytes,
    };
    atomicJson(receiptPath, outcome);
    return outcome;
  } finally {
    if (handle !== undefined) closeSync(handle);
    try { unlinkSync(lock); } catch {}
  }
}

function stopProcessTree(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

function stopPidTree(pid, signal) {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {}
}

function stopOwnedProcessGroup(child) {
  if (!child?.pid || !processGroupAlive(child.pid)) return;
  stopProcessTree(child, "SIGTERM");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  if (processGroupAlive(child.pid)) stopProcessTree(child, "SIGKILL");
}

function closePlaywrightSession(env, cwd) {
  const agentRoot = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const script = join(agentRoot, "npm", "node_modules", "pi-playwright", "skills", "playwright-browser", "scripts", "pw.js");
  if (!existsSync(script)) return null;
  const result = spawnSync(process.execPath, [script, "close"], { cwd, env, encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? null : (result.stderr || result.stdout || result.error?.message || "Playwright close failed").trim();
}

function prepareAgentProfile(directory) {
  const source = agentSourceRoot();
  const target = join(directory, "agent");
  if (existsSync(target)) return target;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of AGENT_PROFILE_FILES) {
    const from = join(source, name);
    if (!existsSync(from)) continue;
    if (name !== "settings.json") {
      copyFileSync(from, join(target, name));
      continue;
    }
    const settings = readJson(from);
    if (!settings) throw new Error(`invalid Pi settings: ${from}`);
    delete settings.defaultProvider;
    delete settings.defaultModel;
    delete settings.enabledModels;
    if (Array.isArray(settings.packages)) {
      settings.packages = settings.packages.filter((entry) => {
        const value = typeof entry === "string" ? entry : entry?.source ?? entry?.package ?? entry?.name ?? "";
        const normalized = String(value).replace(/^npm:/, "");
        return !OPTIONAL_PACKAGES.some((packageName) => normalized === packageName || normalized.startsWith(`${packageName}@`));
      });
    }
    writeFileSync(join(target, name), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  }
  const npm = join(source, "npm");
  if (existsSync(npm)) symlinkSync(npm, join(target, "npm"), process.platform === "win32" ? "junction" : "dir");
  return target;
}

async function supervise(options, piArgs) {
  const root = stateRoot(options);
  const runId = validateRunId(one(options, "run-id"));
  const directory = runDirectory(root, runId);
  const resultPath = join(directory, "result.json");
  const initial = readJson(resultPath);
  if (!initial) fail(`missing run metadata: ${runId}`);
  let earlyCancelRequested = false;
  const earlyCancelSignal = () => { earlyCancelRequested = true; };
  process.on("SIGTERM", earlyCancelSignal);
  const backend = initial.backend ?? "pi";
  const live = initial.live === true;
  const { prompt, args: launchArgs } = extractPrompt(piArgs);
  const customPiLauncher = process.env.SUBWORKER_LAUNCHER ?? process.env.PI_WORKER_LAUNCHER;
  const launcher = backend === "agy"
    ? agyLauncher()
    : backend === "claude"
      ? claudeLauncher(initial.provider)
      : backend === "grok" ? grokLauncher() : (customPiLauncher ?? resolve(dirname(SCRIPT), "../bin/subworker"));
  const defaultPiArgs = live ? ["--mode", "rpc", ...launchArgs] : [...launchArgs, prompt];
  const childArgs = backend === "agy"
    ? agyLaunchArgs({
      args: launchArgs,
      prompt,
      mode: { model: initial.model, thinking: initial.thinking, readOnly: initial.mode === "read" },
      hardTimeoutSeconds: initial.hardTimeoutSeconds,
      conversationId: initial.resumeConversationId ?? null,
      workdir: initial.workdir ?? null,
    })
    : backend === "claude"
      ? claudeLaunchArgs({
        args: launchArgs,
        prompt,
        mode: {
          model: initial.model,
          thinking: initial.thinking,
          permissionMode: initial.mode === "read" ? "plan" : (initial.mode === "write" ? "auto" : "acceptEdits"),
        },
        conversationId: initial.resumeConversationId ?? null,
        allowOrchestration: initial.backendOptions?.allowOrchestration === true,
        systemPrompt: initial.mode === "read"
          ? READ_ONLY_PROMPT
          : "Treat the current working directory as the task root. Write only inside it or TMPDIR; never switch to or edit another checkout.",
      })
      : backend === "grok"
        ? grokLaunchArgs({
          args: launchArgs, prompt,
          mode: { model: initial.model, thinking: initial.thinking, readOnly: initial.mode === "read" },
          session: initial.grokSession,
          conversationId: initial.resumeConversationId,
          workdir: initial.workdir,
          systemPrompt: initial.mode === "read" ? READ_ONLY_PROMPT : "Treat the current working directory as the task root. Write only inside it or TMPDIR; never switch to or edit another checkout.",
        })
        : (customPiLauncher ? defaultPiArgs : ["exec", ...defaultPiArgs]);
  const tmp = join(directory, "tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  atomicJson(resultPath, { ...initial, state: "starting", activity: "waiting_event", supervisorPid: process.pid, startedAt: new Date().toISOString() });
  const startedMs = Date.now();
  let exitCode = null;
  let signal = null;
  let launchError = null;
  let timedOut = false;
  let timeoutType = null;
  let cancelRequested = false;
  let cancelReason = null;
  let summary = { settled: false, lastAssistant: null, usage: {}, assistantCalls: 0, tools: [], playwrightUsed: false, conversationId: null, structuredOutput: null, backendStatus: null, backendTurns: null, backendDeniedActionCount: 0 };
  let stderr = "";
  const attentions = Array.isArray(initial.attentions)
    ? [...initial.attentions]
    : (initial.attention ? [initial.attention] : []);
  const attentionFingerprints = new Set(attentions.map((entry) => fingerprintOf(entry)));
  let attention = attentions.at(-1) ?? null;
  const agentDir = backend === "pi" ? (initial.agentDir ?? prepareAgentProfile(directory)) : null;
  const runEnv = {
    ...process.env,
    ...cacheEnvironment(),
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
    ...(backend === "grok" ? { GROK_HOME: initial.grokSession.home } : {}),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PLAYWRIGHT_CLI_SESSION: `pi-worker-${runId}`,
    PI_PLAYWRIGHT_ARTIFACTS: join(directory, "browser-artifacts"),
  };
  let idleTimer = null;
  let forceTimer = null;
  let rpcShutdownTimer = null;
  let startupAttentionTimer = null;
  let silentReminderTimer = null;
  let silentPeriodStartedAt = null;
  let silentSpanNotified = false;
  let progressStallTimer = null;
  let progressStallSpanStartedAt = null;
  let progressStallNotified = false;
  let settleGraceStartedAt = null;
  let settleGraceTimer = null;
  let steerFallback = null;
  let steerSignal = null;
  let cancelSignal = null;
  let hardTimeout = null;
  let child;
  let settled = false;
  let settleShutdownMarked = false;
  let settleSink = null;
  const activeTools = new Map();
  let firstEventAt = initial.firstEventAt ?? null;
  let firstToolAt = initial.firstToolAt ?? null;
  let lastToolAt = initial.lastToolAt ?? null;
  let lastEventType = initial.lastEventType ?? null;
  let lastEventAt = initial.lastEventAt ?? null;
  let assistantCalls = Number(initial.assistantCalls ?? 0);
  let progressWrites = Number(initial.progressWrites ?? 0);
  let progressState = initial.state ?? "starting";
  let progressActivity = initial.activity ?? "waiting_event";
  let activitySince = initial.activitySince ?? initial.startedAt ?? new Date().toISOString();
  let pendingProgress = null;
  let progressTimer = null;
  let lastProgressWriteMs = 0;
  const flushProgress = () => {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    const snapshot = pendingProgress;
    pendingProgress = null;
    if (!snapshot) return;
    const current = readJson(resultPath);
    if (!current || terminal(current) || current.supervisorPid !== process.pid) return;
    progressWrites += 1;
    atomicJson(resultPath, { ...current, ...snapshot, progressWrites });
    lastProgressWriteMs = Date.now();
  };
  const progressReminderSeconds = Number(initial.progressReminderSeconds ?? (initial.mode === "read" ? 0 : DEFAULT_PROGRESS_REMINDER_SECONDS));
  const clearProgressStallTimer = () => {
    if (progressStallTimer) clearTimeout(progressStallTimer);
    progressStallTimer = null;
  };
  // Bound to markAttention once the try block below defines it; the stall
  // timer lives at function scope because updateProgress arms it per event.
  let stallAttentionHook = null;
  // A stall span is a stretch without any tool start/end boundary. Only tool
  // boundaries open a fresh span: model chunks/thinking keep streaming without
  // restarting it, an active tool suppresses alerts, and the window before the
  // first backend event belongs to startup_silent alone. One span raises at
  // most one progress_stalled alert; the alert never judges or stops the run.
  // A span suppressed because silent_reminder owns the stretch is closed
  // instead, so the first real model event after the silence reopens it.
  const beginProgressStallSpan = () => {
    if (progressReminderSeconds <= 0 || timedOut || settled || cancelRequested || progressState !== "running") return;
    progressStallSpanStartedAt = Date.now();
    progressStallNotified = false;
    clearProgressStallTimer();
    progressStallTimer = setTimeout(() => {
      progressStallTimer = null;
      if (timedOut || settled || cancelRequested || progressState !== "running") return;
      if (activeTools.size > 0 || progressStallNotified || progressStallSpanStartedAt === null) return;
      // A stretch of total backend silence belongs to silent_reminder. When the
      // configured silent interval (which may differ from the progress
      // interval, or be 0 to disable it) has elapsed with no event at all, that
      // reminder owns the alert for this stretch. Close the stall span so the
      // first real non-tool model event after the silence opens a fresh
      // reminder window; leaving the span open with no timer would never
      // notify again. Chunks themselves never reset the clock.
      const silentReminderSeconds = Number(initial.silentReminderSeconds ?? 0);
      const quietMs = silentPeriodStartedAt === null ? Number.POSITIVE_INFINITY : Date.now() - silentPeriodStartedAt;
      if (silentReminderSeconds > 0 && quietMs >= silentReminderSeconds * 1000) {
        progressStallSpanStartedAt = null;
        return;
      }
      progressStallNotified = true;
      const spanSeconds = Math.round((Date.now() - progressStallSpanStartedAt) / 100) / 10;
      const spanMark = new Date(progressStallSpanStartedAt).toISOString();
      stallAttentionHook?.("progress_stalled", `No tool start or finish observed for ${spanSeconds} seconds since ${spanMark}; the worker is still running without observable tool progress.`);
    }, progressReminderSeconds * 1000);
    progressStallTimer.unref();
  };
  const updateProgress = (event = undefined, forcedState = null) => {
    const at = new Date().toISOString();
    const firstActivity = event !== undefined && firstEventAt === null;
    if (event !== undefined) {
      firstEventAt ??= at;
      lastEventAt = at;
      lastEventType = event?.type ?? "stderr";
      if (event?.type === "tool_execution_start") {
        firstToolAt ??= at;
        lastToolAt = at;
        const id = String(event.toolCallId ?? event.id ?? `${event.toolName ?? "tool"}-${at}`);
        activeTools.set(id, { id, name: event.toolName ?? null, startedAt: at });
      } else if (event?.type === "tool_execution_end") {
        lastToolAt = at;
        const id = event.toolCallId ?? event.id;
        if (id !== undefined) activeTools.delete(String(id));
        else {
          const match = [...activeTools].find(([, tool]) => tool.name === (event.toolName ?? null));
          if (match) activeTools.delete(match[0]);
        }
      } else if (event?.type === "message_end" && event.message?.role === "assistant") {
        assistantCalls += 1;
      }
    }
    let state = forcedState ?? progressState;
    if (!forcedState && !["stopping", "finalizing"].includes(state)) {
      state = event?.type === "agent_settled" ? "finalizing" : "running";
    }
    const activity = ["stopping", "finalizing"].includes(state)
      ? null
      : (activeTools.size > 0 ? "running_tools" : (firstEventAt ? "waiting_model" : "waiting_event"));
    if (activity !== progressActivity) activitySince = at;
    progressState = state;
    progressActivity = activity;
    // Progress-stall timing: only tool start/end boundaries are observable
    // tool progress, so only they reset the span (or close it while a tool is
    // active). Chunks/thinking and other model output never reset the clock;
    // after the last tool ends a fresh span starts, and a span closed by a
    // silent_reminder-owned window reopens on the next real model event.
    if (event !== undefined && progressState === "running") {
      const isToolBoundary = event?.type === "tool_execution_start" || event?.type === "tool_execution_end";
      if (isToolBoundary) {
        clearProgressStallTimer();
        progressStallSpanStartedAt = null;
        progressStallNotified = false;
        if (activeTools.size === 0) beginProgressStallSpan();
      } else if (event !== null && activeTools.size === 0 && firstEventAt !== null && progressStallSpanStartedAt === null) {
        beginProgressStallSpan();
      }
    }
    pendingProgress = {
      state,
      activity,
      activitySince,
      firstEventAt,
      lastEventAt,
      firstToolAt,
      lastToolAt,
      lastEventType,
      assistantCalls,
      activeTools: [...activeTools.values()].slice(0, 10),
    };
    const important = forcedState !== null
      || event === undefined
      || firstActivity
      || ["tool_execution_start", "tool_execution_end", "message_end", "agent_settled"].includes(event?.type);
    if (important || Date.now() - lastProgressWriteMs >= PROGRESS_WRITE_MS) {
      flushProgress();
    } else if (!progressTimer) {
      progressTimer = setTimeout(flushProgress, PROGRESS_WRITE_MS - (Date.now() - lastProgressWriteMs));
      progressTimer.unref();
    }
  };
  try {
    const stopChild = () => {
      if (!child) return;
      stopProcessTree(child, "SIGTERM");
      if (forceTimer) clearTimeout(forceTimer);
      forceTimer = setTimeout(() => stopProcessTree(child, "SIGKILL"), 5_000);
      forceTimer.unref();
    };
    const stopForTimeout = (kind) => {
      if (timedOut || !child) return;
      timedOut = true;
      timeoutType = kind;
      if (kind === "rpc_shutdown") markAttention("rpc_shutdown_timeout", "Pi did not exit after agent_settled");
      updateProgress(undefined, "stopping");
      stopChild();
    };
    const resetIdle = () => {
      if (initial.idleTimeoutSeconds <= 0 || timedOut) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stopForTimeout("idle"), initial.idleTimeoutSeconds * 1000);
      idleTimer.unref();
    };
    const markActivity = (event) => {
      const now = Date.now();
      if (firstEventAt === null) {
        if (startupAttentionTimer) {
          clearTimeout(startupAttentionTimer);
          startupAttentionTimer = null;
        }
      }
      // One silent span runs from the last real backend event. Every real
      // event restarts it and clears the notified flag, so a later quiet
      // phase starts a fresh reminder cycle; one ongoing silence raises at
      // most one reminder (never a repeating timer spam).
      if (event !== null) {
        if (silentSpanNotified) silentSpanNotified = false;
        silentPeriodStartedAt = now;
      }
      resetIdle();
      updateProgress(event);
    };
    const markAttention = (category, detail) => {
      const safeDetail = redactText(detail).slice(-4_096);
      const fingerprint = attentionFingerprint(category, safeDetail);
      const now = new Date().toISOString();
      const duplicate = attentions.find((entry) => fingerprintOf(entry) === fingerprint);
      if (duplicate) {
        // Keep the original detectedAt: receipts are keyed on it (legacy) or on
        // the content fingerprint and must not re-deliver on later repeats of
        // the same error.
        return;
      }
      // Simple bounded queue of at most ATTENTION_LIMIT entries: every new
      // alert enters and the oldest leaves, so the window always reflects the
      // newest errors (a late 401 is never hidden behind eight earlier ones).
      if (attentions.length >= ATTENTION_LIMIT) {
        const victim = attentions.shift();
        attentionFingerprints.delete(fingerprintOf(victim));
      }
      // Current advice is advisory only: it never blocks continue, gates
      // dispatch, stops tool tasks, or kills processes. Persist it at top
      // level too so on-demand diagnose sees the same advice wait receives;
      // wait alert spread and receipts are unchanged (same notifyWaiter path).
      const entry = {
        category,
        detail: safeDetail,
        fingerprint,
        detectedAt: now,
        retryGuidance: buildRetryGuidance({ category, terminal: false }),
      };
      attentionFingerprints.add(fingerprint);
      attentions.push(entry);
      attention = entry;
      atomicJson(join(directory, "attention.json"), { events: attentions });
      const live = readJson(resultPath);
      if (live && !terminal(live)) {
        atomicJson(resultPath, {
          ...live,
          attention: entry,
          attentions,
          providerRetryCount: live.providerRetryCount ?? null,
          retryGuidance: entry.retryGuidance,
        });
      }
      notifyWaiter(directory);
    };
    stallAttentionHook = markAttention;
    const steerDir = join(directory, "steer");
    const ackDir = join(steerDir, "acks");
    const cancelPath = join(directory, "cancel.json");
    cancelSignal = () => {
      if (cancelRequested) return;
      const request = readJson(cancelPath);
      cancelRequested = true;
      cancelReason = request?.reason || "cancel requested";
      clearProgressStallTimer();
      updateProgress(undefined, "stopping");
      stopChild();
    };
    process.off("SIGTERM", earlyCancelSignal);
    process.on("SIGTERM", cancelSignal);
    if (earlyCancelRequested || existsSync(cancelPath)) cancelSignal();
    if (live) mkdirSync(ackDir, { recursive: true, mode: 0o700 });
    child = spawn(launcher, childArgs, {
      cwd: initial.workdir,
      detached: process.platform !== "win32",
      env: runEnv,
      stdio: [live ? "pipe" : "ignore", "pipe", "pipe"],
    });
    child.stdin?.on("error", () => {});
    atomicJson(resultPath, { ...readJson(resultPath), childPid: child.pid });
    const sendRpc = (value) => {
      if (!child.stdin.writable || child.exitCode !== null) throw new Error("Pi RPC stdin is closed");
      child.stdin.write(`${JSON.stringify(value)}\n`);
    };
    const acknowledge = (id, success, error = null) => atomicJson(join(ackDir, `${id}.json`), {
      id,
      success,
      error: error ? redactText(error).slice(0, TOOL_ERROR_BYTES) : null,
      acknowledgedAt: new Date().toISOString(),
    });
    const drainSteer = () => {
      for (const name of readdirSync(steerDir).filter((entry) => entry.endsWith(".json"))) {
        const path = join(steerDir, name);
        const value = readJson(path);
        try {
          if (!value?.id || value.id !== name.slice(0, -5) || value.type !== "steer" || !value.message) throw new Error("invalid steer payload");
          sendRpc(value);
        } catch (error) {
          if (value?.id) acknowledge(value.id, false, error.message);
          markAttention("steer_delivery_failed", error.message);
        } finally {
          try { unlinkSync(path); } catch {}
        }
      }
    };
    const onResponse = (event) => {
      if (event.id === `prompt-${runId}` && event.success === false) {
        markAttention("prompt_rejected", event.error ?? "initial prompt rejected");
        child.stdin.end();
      } else if (String(event.id ?? "").startsWith("steer-")) {
        acknowledge(event.id, Boolean(event.success), event.error);
      }
    };
    const onSettled = () => {
      if (settleSink) settleSink();
    };
    if (live && process.platform !== "win32") {
      steerSignal = () => drainSteer();
      process.on("SIGUSR2", steerSignal);
    }
    if (live) {
      steerFallback = setInterval(drainSteer, 5_000);
      steerFallback.unref();
    }
    atomicJson(resultPath, { ...readJson(resultPath), supervisorPid: process.pid, childPid: child.pid });
    updateProgress(undefined, "running");
    resetIdle();
    if (firstEventAt === null) {
      if (initial.startupAttentionSeconds > 0) {
        startupAttentionTimer = setTimeout(() => {
          if (firstEventAt === null) {
            markAttention("startup_silent", `No backend event received within ${initial.startupAttentionSeconds} seconds; the worker is still running.`);
          }
        }, initial.startupAttentionSeconds * 1000);
        startupAttentionTimer.unref();
      }
    } else {
      silentPeriodStartedAt = Date.now();
    }
    if (cancelRequested) {
      updateProgress(undefined, "stopping");
      stopChild();
    }
    // Settled exit contract, shared by all three backends. The receipt that
    // matters is the stdio close event, not child.exitCode: the child process
    // may have exited while a background descendant still holds stdout open.
    // From the terminal event we always start a bounded grace window; when it
    // expires the process group is stopped precisely (this also stops
    // background descendants that keep the pipe open) and the run fails
    // explicitly instead of hanging on close forever.
    let exitResolve = null;
    const exitPromise = new Promise((resolveExit) => { exitResolve = resolveExit; });
    const onClose = (code, childSignal) => {
      if (settleGraceTimer) {
        clearTimeout(settleGraceTimer);
        settleGraceTimer = null;
      }
      exitResolve({ exitCode: code, signal: childSignal, launchError: null });
    };
    child.once("error", (error) => exitResolve({ exitCode: null, signal: null, launchError: error.message }));
    child.once("close", onClose);
    const armSettleGrace = () => {
      if (settleGraceTimer || settleGraceStartedAt !== null) return;
      settleGraceStartedAt = Date.now();
      settleGraceTimer = setTimeout(() => {
        settleGraceTimer = null;
        if (settleShutdownMarked) return;
        // Force the whole process group: the parent may already be gone while
        // a background descendant still holds stdout open and delays close.
        settleShutdownMarked = true;
        stopChild();
        markAttention("shutdown_problem", "Backend stayed alive after its terminal event; the process group was stopped.");
      }, SETTLE_GRACE_SECONDS * 1000);
      settleGraceTimer.unref();
    };
    settleSink = () => {
      if (settled) return;
      settled = true;
      clearProgressStallTimer();
      if (live) {
        if (child.stdin.writable) child.stdin.end();
        rpcShutdownTimer = setTimeout(() => stopForTimeout("rpc_shutdown"), 5_000);
        rpcShutdownTimer.unref();
      } else {
        // Every headless settled receipt starts the same bounded grace window,
        // regardless of idle/hard timeouts: close completion is the receipt.
        armSettleGrace();
      }
    };
    const summaryPromise = backend === "agy"
      ? summarizeAgyStream(child.stdout, { onActivity: markActivity, onAttention: markAttention, onSettled, classifyAttention })
      : backend === "claude" || backend === "grok"
        ? summarizeClaudeStream(child.stdout, { onActivity: markActivity, onAttention: markAttention, onSettled, classifyAttention, backendName: backend })
        : summarizeStream(child.stdout, markActivity, markAttention, onResponse, onSettled);
    const stderrPromise = collectTail(child.stderr, markActivity, markAttention);
    let streamError = null;
    let handleStreamReject;
    const streamRejectPromise = new Promise((_, reject) => {
      handleStreamReject = reject;
    });
    summaryPromise.catch((err) => {
      streamError ||= err;
      stopChild();
      stopOwnedProcessGroup(child);
      handleStreamReject(err);
    });
    stderrPromise.catch((err) => {
      streamError ||= err;
      stopChild();
      stopOwnedProcessGroup(child);
      handleStreamReject(err);
    });
    hardTimeout = initial.hardTimeoutSeconds > 0 ? setTimeout(() => {
      stopForTimeout("hard");
    }, initial.hardTimeoutSeconds * 1000) : null;
    if (!live && initial.silentReminderSeconds > 0) {
      const armSilentReminder = () => {
        if (timedOut || settled) return;
        silentReminderTimer = setTimeout(() => {
          if (timedOut || settled) return;
          const now = Date.now();
          // One soft alert per silent span; real activity restarts the span
          // and may therefore start a fresh reminder cycle later.
          if (silentPeriodStartedAt !== null && !silentSpanNotified && now - silentPeriodStartedAt >= initial.silentReminderSeconds * 1000) {
            silentSpanNotified = true;
            const spanSeconds = Math.round((now - silentPeriodStartedAt) / 100) / 10;
            const spanMark = new Date(silentPeriodStartedAt).toISOString();
            markAttention("silent_reminder", `No backend event for ${spanSeconds} seconds since ${spanMark}; the worker is still running.`);
          }
          armSilentReminder();
        }, initial.silentReminderSeconds * 1000);
        silentReminderTimer.unref();
      };
      armSilentReminder();
    }
    if (live) {
      sendRpc({ id: `prompt-${runId}`, type: "prompt", message: prompt });
      drainSteer();
    }
    try {
      ({ exitCode, signal, launchError } = await Promise.race([
        exitPromise,
        streamRejectPromise,
      ]));
    } catch (err) {
      launchError = err.message;
    }
    stopOwnedProcessGroup(child);
    updateProgress(undefined, "finalizing");
    if (!launchError && !streamError) {
      try {
        [summary, stderr] = await Promise.all([summaryPromise, stderrPromise]);
      } catch (err) {
        launchError = err.message;
      }
    } else {
      launchError ||= streamError?.message;
      try {
        [summary, stderr] = await Promise.all([
          summaryPromise.catch(() => summary),
          stderrPromise.catch(() => stderr),
        ]);
      } catch {}
    }
  } catch (error) {
    launchError = error.message;
  } finally {
    if (hardTimeout) clearTimeout(hardTimeout);
    if (idleTimer) clearTimeout(idleTimer);
    if (forceTimer) clearTimeout(forceTimer);
    if (rpcShutdownTimer) clearTimeout(rpcShutdownTimer);
    if (startupAttentionTimer) clearTimeout(startupAttentionTimer);
    if (silentReminderTimer) clearTimeout(silentReminderTimer);
    if (progressStallTimer) clearTimeout(progressStallTimer);
    if (settleGraceTimer) clearTimeout(settleGraceTimer);
    if (progressTimer) clearTimeout(progressTimer);
    if (steerFallback) clearInterval(steerFallback);
    if (steerSignal) process.off("SIGUSR2", steerSignal);
    if (cancelSignal) process.off("SIGTERM", cancelSignal);
    process.off("SIGTERM", earlyCancelSignal);
    if (child?.stdin?.writable) child.stdin.end();
    stopOwnedProcessGroup(child);
    rmSync(tmp, { recursive: true, force: true });
  }

  const playwrightCleanupError = backend === "pi" && summary.playwrightUsed ? closePlaywrightSession(runEnv, initial.workdir) : null;
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  let patch = { patchPath: null, patchBytes: 0 };
  let patchError = null;
  try { patch = capturePatch(initial, directory); } catch (error) { patchError = error.message; }
  const assistantFailed = summary.lastAssistant?.stopReason === "error" || summary.lastAssistant?.error;
  const emptyFinal = !summary.lastAssistant?.text?.trim();
  const success = !cancelRequested && exitCode === 0 && settled && summary.settled && !assistantFailed && !emptyFinal && !launchError && !timedOut && !settleShutdownMarked && !patchError && !playwrightCleanupError;
  const reason = success ? null : (
    (cancelRequested ? cancelReason : null) ?? patchError ?? playwrightCleanupError ?? launchError
    ?? (timedOut ? `${timeoutType} timeout` : null) ?? summary.lastAssistant?.error
    ?? (!summary.settled ? (backend === "agy" ? "missing Agy terminal result" : backend === "claude" ? "missing Claude terminal result" : backend === "grok" ? "missing Grok terminal result" : "missing agent_settled") : null)
    ?? (settleShutdownMarked ? "unclean shutdown after the terminal event" : null)
    ?? (emptyFinal ? "empty final response" : `exit ${exitCode}`)
  );
  const reasonCode = success ? null : (
    cancelRequested ? "user_cancelled"
      : patchError ? "patch_error"
        : playwrightCleanupError ? "cleanup_error"
          : launchError ? "launch_error"
            : timedOut ? `${timeoutType}_timeout`
              : summary.lastAssistant?.error ? "provider_error"
                : !summary.settled ? "missing_settled"
                  : settleShutdownMarked ? "shutdown_problem"
                    : emptyFinal ? "empty_final" : "process_exit"
  );
  let failureLogPath = null;
  if (!success) {
    failureLogPath = join(directory, "failure.log");
    writeFileSync(failureLogPath, `${redactText([reason, stderr].filter(Boolean).join("\n\n")).slice(-FAILURE_TAIL_BYTES)}\n`, { mode: 0o600 });
  }
  atomicJson(resultPath, {
    ...(readJson(resultPath) ?? initial),
    state: success ? "success" : (cancelRequested ? "cancelled" : "failed"),
    activity: null,
    activitySince: null,
    activeTools: [],
    exitCode,
    signal,
    backend,
    agentSettled: summary.settled,
    reason,
    reasonCode,
    timeoutType,
    provider: initial.provider,
    model: initial.model,
    observedProvider: summary.lastAssistant?.provider ?? null,
    observedModel: summary.lastAssistant?.model ?? null,
    thinking: initial.thinking,
    finalText: summary.lastAssistant?.text ?? "",
    conversationId: summary.conversationId ?? initial.conversationId ?? null,
    structuredOutput: summary.structuredOutput ?? null,
    backendStatus: summary.backendStatus ?? null,
    backendTurns: summary.backendTurns ?? null,
    backendDeniedActionCount: summary.backendDeniedActionCount ?? 0,
    usage: summary.usage,
    assistantCalls: summary.assistantCalls,
    reportedReasoningTokens: Number.isFinite(summary.usage?.reasoning)
      ? summary.usage.reasoning
      : (Number.isFinite(summary.usage?.thinking_tokens)
        ? summary.usage.thinking_tokens
        : (Number.isFinite(summary.usage?.output_tokens_details?.thinking_tokens)
          ? summary.usage.output_tokens_details.thinking_tokens
          : null)),
    tools: summary.tools,
    attention,
    attentions,
    providerRetryCount: summary.providerRetryCount ?? null,
    // Success and explicit cancellation clear current advice even after a
    // transient alert; only failed runs keep terminal guidance. Null/absent
    // and soft categories (startup_silent/silent_reminder/progress_stalled)
    // never claim "unknown error" — they resolve to null.
    retryGuidance: (success || cancelRequested)
      ? null
      : buildRetryGuidance({
        category: attention?.category ?? null,
        terminal: true,
        providerRetryCount: summary.providerRetryCount ?? null,
      }),
    progressWrites,
    ...patch,
    failureLogPath,
    reviewPending: initial.mode !== "read",
    cleanupRequired: true,
    worker: {
      version: WORKER_VERSION,
      brand: WORKER_BRAND,
    },
    dispatcher: dispatcherFacts(),
    backendVersion: backendVersion(),
    finishedAt: new Date().toISOString(),
    elapsedSeconds: Math.round((Date.now() - startedMs) / 100) / 10,
  });
  try { unlinkSync(join(directory, "cancel.json")); } catch {}
  // The last attention may have arrived while the terminal receipt was being
  // written; make one final pass so every waiter wakes on the durable state.
  notifyWaiter(directory);
}

function startSupervisor(root, runId, piArgs) {
  const supervisor = spawn(
    process.execPath,
    [SCRIPT, "supervise", "--run-id", runId, "--state-root", root, "--", ...piArgs],
    { detached: true, env: { ...process.env, [prefixed("STATE_ROOT")]: root }, stdio: "ignore" },
  );
  supervisor.unref();
  return supervisor.pid;
}

function dispatch(options, piArgs) {
  const root = stateRoot(options);
  const runId = validateRunId(one(options, "run-id"));
  const backend = one(options, "backend", "pi");
  if (!["pi", "agy", "claude", "grok"].includes(backend)) fail("--backend must be pi, agy, claude, or grok");
  const mode = one(options, "mode", one(options, "source") ? "write" : "read");
  if (!["read", "write", "in-place"].includes(mode)) fail("--mode must be read, write, or in-place");
  if (piArgs.length === 0) fail("dispatch requires backend arguments after --");
  const capabilities = options.get("capability") ?? [];
  if (backend !== "pi" && capabilities.length > 0) fail(`${backend} backend does not support Pi capabilities`);
  if (backend !== "pi" && options.has("live")) fail(`${backend} backend does not support --live; use continue after completion`);
  let selection;
  let effectiveArgs;
  try {
    if (backend === "agy") {
      const { prompt, args } = extractPrompt(piArgs);
      selection = selectAgy(args);
      selection.args = applyNativePermissions(backend, selection.args);
      effectiveArgs = [...selection.args, prompt];
    } else if (backend === "claude") {
      const { prompt, args } = extractPrompt(piArgs);
      selection = selectClaude(args);
      selection.args = applyNativePermissions(backend, selection.args);
      effectiveArgs = [...selection.args, prompt];
    } else if (backend === "grok") {
      const { prompt, args } = extractPrompt(piArgs);
      selection = selectGrok(args);
      selection.args = applyNativePermissions(backend, selection.args);
      effectiveArgs = [...selection.args, prompt];
    } else {
      selection = applyDispatchProfile(piArgs);
      const taskArgs = mode === "read" ? ["--append-system-prompt", READ_ONLY_PROMPT, ...selection.args] : selection.args;
      effectiveArgs = applyCapabilities(taskArgs, capabilities, mode === "read" ? READ_TOOLS : BASE_TOOLS);
    }
  } catch (error) {
    fail(error.message);
  }
  const hardTimeoutSeconds = Number(one(options, "hard-timeout", "0"));
  if (!Number.isFinite(hardTimeoutSeconds) || hardTimeoutSeconds < 0) fail("--hard-timeout must be zero or positive");
  const idleTimeoutSeconds = Number(one(options, "idle-timeout", "0"));
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds < 0) fail("--idle-timeout must be zero or positive");
  const startupAttentionSeconds = Number(one(options, "startup-attention", String(DEFAULT_STARTUP_ATTENTION_SECONDS)));
  if (!Number.isFinite(startupAttentionSeconds) || startupAttentionSeconds < 0) fail("--startup-attention must be zero or positive");
  const silentReminderSeconds = Number(one(options, "silent-reminder", String(DEFAULT_SILENT_REMINDER_SECONDS)));
  if (!Number.isFinite(silentReminderSeconds) || silentReminderSeconds < 0) fail("--silent-reminder must be zero or positive");
  const progressReminderSeconds = Number(one(options, "progress-reminder", String(mode === "read" ? 0 : DEFAULT_PROGRESS_REMINDER_SECONDS)));
  if (!Number.isFinite(progressReminderSeconds) || progressReminderSeconds < 0) fail("--progress-reminder must be zero or positive");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = runDirectory(root, runId);
  if (existsSync(directory)) fail(`run already exists: ${runId}`);
  mkdirSync(directory, { mode: 0o700 });
  const sessionDir = backend === "pi" ? join(directory, "session") : null;

  let workspace;
  let agentDir;
  try {
    if (backend === "pi") {
      agentDir = prepareAgentProfile(directory);
      mkdirSync(sessionDir, { mode: 0o700 });
    }
    if (mode === "write") {
      const source = one(options, "source");
      if (!source) throw new Error("write mode requires --source");
      workspace = { ...createManagedWorktree(source, directory), managedWorktree: true };
    } else {
      const workdir = resolve(one(options, "workdir", process.cwd()));
      if (!existsSync(workdir) || !statSync(workdir).isDirectory()) throw new Error(`workdir is not a directory: ${workdir}`);
      workspace = { sourceRoot: workdir, worktree: workdir, baseCommit: null, baselineTree: null, managedWorktree: false };
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    fail(error.message);
  }

  atomicJson(join(directory, "result.json"), {
    schema: 3,
    runId,
    backend,
    state: "starting",
    activity: "waiting_event",
    mode,
    worker: { version: WORKER_VERSION, brand: WORKER_BRAND },
    dispatcher: dispatcherFacts(),
    backendVersion: null,
    sourceRoot: workspace.sourceRoot,
    workdir: workspace.worktree,
    managedWorktree: workspace.managedWorktree,
    sessionDir,
    grokSession: backend === "grok" ? createGrokSession(workspace.worktree) : null,
    agentDir,
    turnIndex: 1,
    firstEventAt: null,
    lastEventAt: null,
    firstToolAt: null,
    lastToolAt: null,
    lastEventType: null,
    assistantCalls: 0,
    progressWrites: 0,
    activeTools: [],
    baseCommit: workspace.baseCommit,
    baselineTree: workspace.baselineTree,
    provider: selection.provider ?? null,
    model: selection.model,
    thinking: selection.thinking,
    backendArgs: backend === "pi" ? null : selection.args,
    backendOptions: backend === "claude" ? { allowOrchestration: selection.allowOrchestration } : null,
    capabilities,
    live: options.has("live"),
    hardTimeoutSeconds,
    idleTimeoutSeconds,
    startupAttentionSeconds,
    silentReminderSeconds,
    progressReminderSeconds,
    attention: null,
    attentions: [],
    dispatchedAt: new Date().toISOString(),
  });
  const supervisorPid = startSupervisor(root, runId, backend === "pi" ? ["--session-dir", sessionDir, ...effectiveArgs] : effectiveArgs);
  atomicJson(join(directory, "result.json"), { ...readJson(join(directory, "result.json")), supervisorPid });
  console.log(JSON.stringify({ runId, state: "running", backend, mode, live: options.has("live"), supervisorPid, workdir: workspace.worktree, sessionDir, directory }));
}

function continueRun(options, promptArgs) {
  const root = stateRoot(options);
  const runId = validateRunId(one(options, "run-id"));
  const directory = runDirectory(root, runId);
  const resultPath = join(directory, "result.json");
  const previous = readJson(resultPath);
  if (!terminal(previous)) fail(`run is not ready to continue: ${runId}`);
  const backend = previous.backend ?? "pi";
  if (backend !== "pi" && options.has("live")) fail(`${backend} backend does not support --live; continue as a normal headless turn`);
  if (promptArgs.length === 0) fail("continue requires a prompt after --");
  if (backend === "pi" && (!previous.sessionDir || !existsSync(previous.sessionDir))) fail(`managed session is unavailable: ${runId}`);
  if (backend === "agy" && !previous.conversationId) fail(`Agy conversation is unavailable: ${runId}`);
  if (backend === "claude" && !previous.conversationId) fail(`Claude session is unavailable: ${runId}`);
  if (backend === "grok" && (!previous.conversationId || previous.conversationId !== previous.grokSession?.id)) fail(`Owned Grok session is unavailable: ${runId}`);
  if (!existsSync(previous.workdir)) fail(`worker directory is unavailable: ${previous.workdir}`);
  let effectiveArgs;
  if (backend === "agy" || backend === "claude" || backend === "grok") {
    const { prompt, args } = extractPrompt(promptArgs);
    if (args.length > 0) fail(`${backend} continue accepts only one prompt after --`);
    effectiveArgs = [...applyNativePermissions(backend, previous.backendArgs ?? []), prompt];
  } else {
    const selection = applyDispatchProfile([
      "--provider", previous.provider,
      "--model", previous.model,
      "--thinking", previous.thinking,
      ...promptArgs,
    ]);
    const taskArgs = previous.mode === "read" ? ["--append-system-prompt", READ_ONLY_PROMPT, "--continue", ...selection.args] : ["--continue", ...selection.args];
    effectiveArgs = applyCapabilities(taskArgs, previous.capabilities ?? [], previous.mode === "read" ? READ_TOOLS : BASE_TOOLS);
  }
  const idleTimeoutSeconds = Number(one(options, "idle-timeout", String(previous.idleTimeoutSeconds ?? 0)));
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds < 0) fail("--idle-timeout must be zero or positive");
  const startupAttentionSeconds = Number(one(options, "startup-attention", String(previous.startupAttentionSeconds ?? DEFAULT_STARTUP_ATTENTION_SECONDS)));
  if (!Number.isFinite(startupAttentionSeconds) || startupAttentionSeconds < 0) fail("--startup-attention must be zero or positive");
  const silentReminderSeconds = Number(one(options, "silent-reminder", String(previous.silentReminderSeconds ?? DEFAULT_SILENT_REMINDER_SECONDS)));
  if (!Number.isFinite(silentReminderSeconds) || silentReminderSeconds < 0) fail("--silent-reminder must be zero or positive");
  const progressReminderSeconds = Number(one(options, "progress-reminder", String(previous.progressReminderSeconds ?? (previous.mode === "read" ? 0 : DEFAULT_PROGRESS_REMINDER_SECONDS))));
  if (!Number.isFinite(progressReminderSeconds) || progressReminderSeconds < 0) fail("--progress-reminder must be zero or positive");
  const turns = [...(previous.turns ?? []), {
    turnIndex: previous.turnIndex ?? 1,
    state: previous.state,
    finalText: previous.finalText,
    usage: previous.usage,
    reasonCode: previous.reasonCode ?? null,
    reason: previous.reason ?? null,
    attention: previous.attention ?? null,
    observedProvider: previous.observedProvider ?? null,
    observedModel: previous.observedModel ?? null,
    assistantCalls: previous.assistantCalls ?? 0,
    reportedReasoningTokens: previous.reportedReasoningTokens ?? null,
    elapsedSeconds: previous.elapsedSeconds ?? null,
    tools: previous.tools ?? [],
    conversationId: previous.conversationId ?? null,
    backendTurns: previous.backendTurns ?? null,
    providerRetryCount: previous.providerRetryCount ?? null,
    retryGuidance: previous.retryGuidance ?? null,
    worker: previous.worker ?? { version: WORKER_VERSION, brand: WORKER_BRAND },
    finishedAt: previous.finishedAt,
  }];
  let supervisorPid;
  try {
    supervisorPid = withRunLock(directory, () => {
      const current = readJson(resultPath);
      if (!terminal(current) || current.finishedAt !== previous.finishedAt) throw new Error(`run changed before continuation: ${runId}`);
      const agentDir = backend === "pi" ? prepareAgentProfile(directory) : null;
      atomicJson(resultPath, {
        ...previous,
        state: "starting",
        activity: "waiting_event",
        supervisorPid: null,
        childPid: null,
        agentDir,
        resumeConversationId: backend === "pi" ? null : previous.conversationId,
        backendArgs: backend === "pi" ? previous.backendArgs : extractPrompt(effectiveArgs).args,
        turnIndex: (previous.turnIndex ?? 1) + 1,
        turns,
        firstEventAt: null,
        lastEventAt: null,
        firstToolAt: null,
        lastToolAt: null,
        lastEventType: null,
        assistantCalls: 0,
        progressWrites: 0,
        reportedReasoningTokens: null,
        activeTools: [],
        exitCode: null,
        signal: null,
        agentSettled: false,
        reason: null,
        reasonCode: null,
        timeoutType: null,
        finalText: "",
        structuredOutput: null,
        backendStatus: null,
        backendTurns: null,
        usage: null,
        tools: [],
        attention: null,
        attentions: [],
        providerRetryCount: null,
        retryGuidance: null,
        // Stamp the actually running runtime on every continued turn; the old
        // facts stay in turns[] history (worker field above) instead of
        // claiming the previous launcher is still running.
        worker: { version: WORKER_VERSION, brand: WORKER_BRAND },
        dispatcher: previous.dispatcher ?? dispatcherFacts(),
        backendVersion: null,
        live: options.has("live"),
        idleTimeoutSeconds,
        startupAttentionSeconds,
        silentReminderSeconds,
        progressReminderSeconds,
        elapsedSeconds: null,
        failureLogPath: null,
        dispatchedAt: new Date().toISOString(),
        finishedAt: null,
      });
      try { unlinkSync(join(directory, "attention.json")); } catch {}
      try { unlinkSync(join(directory, "failure.log")); } catch {}
      const pid = startSupervisor(root, runId, backend === "pi" ? ["--session-dir", previous.sessionDir, ...effectiveArgs] : effectiveArgs);
      atomicJson(resultPath, { ...readJson(resultPath), supervisorPid: pid });
      return pid;
    });
  } catch (error) {
    fail(error.message, 3);
  }
  console.log(JSON.stringify({ runId, state: "running", backend, mode: previous.mode, live: options.has("live"), turnIndex: (previous.turnIndex ?? 1) + 1, supervisorPid, workdir: previous.workdir, sessionDir: previous.sessionDir, directory }));
}

async function steerRun(options, messageArgs) {
  const root = stateRoot(options);
  const runId = validateRunId(one(options, "run-id"));
  const directory = runDirectory(root, runId);
  const message = messageArgs.join("\n").trim();
  if (!message) fail("steer requires a message after --");
  if (Buffer.byteLength(message) > STEER_MAX_BYTES) fail(`steer message exceeds ${STEER_MAX_BYTES} bytes`);
  const timeoutSeconds = Number(one(options, "timeout", "15"));
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) fail("--timeout must be positive");
  const deadline = Date.now() + timeoutSeconds * 1000;
  let result;
  while (Date.now() < deadline) {
    result = readJson(join(directory, "result.json"));
    if (terminal(result)) fail(`run is already finished: ${runId}`);
    if (result?.live !== true) fail(`run is not live; dispatch or continue with --live before using steer: ${runId}`);
    if (result?.state === "running" && processAlive(result.supervisorPid)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!result || result.state !== "running" || !processAlive(result.supervisorPid)) fail(`run is not steerable: ${runId}`, 3);
  const id = `steer-${Date.now()}-${process.pid}`;
  const steerDir = join(directory, "steer");
  const ackDir = join(steerDir, "acks");
  mkdirSync(ackDir, { recursive: true, mode: 0o700 });
  const queuePath = join(steerDir, `${id}.json`);
  const ackPath = join(ackDir, `${id}.json`);
  atomicJson(queuePath, { id, type: "steer", message, queuedAt: new Date().toISOString() });
  if (process.platform !== "win32") {
    try { process.kill(result.supervisorPid, "SIGUSR2"); } catch {}
  }
  while (Date.now() < deadline) {
    const ack = readJson(ackPath);
    if (ack) {
      try { unlinkSync(ackPath); } catch {}
      console.log(JSON.stringify({ runId, ...ack }));
      if (!ack.success) process.exitCode = 3;
      return;
    }
    const current = readJson(join(directory, "result.json"));
    if (terminal(current) || !processAlive(current?.supervisorPid)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  try { unlinkSync(queuePath); } catch {}
  fail(`steer acknowledgement timed out: ${runId}`, 3);
}

function runIds(options) {
  return (options.get("run-id") ?? []).flatMap((value) => value.split(",")).map((value) => validateRunId(value.trim()));
}

function currentResults(root, ids) {
  return ids.map((runId) => ({ runId, result: readJson(join(runDirectory(root, runId), "result.json")) }));
}

function terminal(result) {
  return result && ["success", "failed", "cancelled"].includes(result.state);
}

function resultReceipt(root, result) {
  const finalText = String(result.finalText ?? "");
  return {
    schema: result.schema,
    runId: result.runId,
    state: result.state,
    backend: result.backend ?? "pi",
    mode: result.mode,
    provider: result.provider,
    model: result.model,
    thinking: result.thinking,
    observedProvider: result.observedProvider,
    observedModel: result.observedModel,
    conversationId: result.conversationId ?? null,
    backendStatus: result.backendStatus ?? null,
    backendTurns: result.backendTurns ?? null,
    backendDeniedActionCount: result.backendDeniedActionCount ?? 0,
    elapsedSeconds: result.elapsedSeconds,
    worker: result.worker,
    dispatcher: result.dispatcher,
    backendVersion: result.backendVersion,
    assistantCalls: result.assistantCalls,
    usage: result.usage,
    reportedReasoningTokens: result.reportedReasoningTokens,
    tools: (result.tools ?? []).map(({ name, count, errorCount }) => ({ name, count, errorCount })),
    reason: result.reason,
    reasonCode: result.reasonCode,
    attention: result.attention,
    attentions: result.attentions ?? (result.attention ? [result.attention] : []),
    providerRetryCount: result.providerRetryCount ?? null,
    retryGuidance: result.retryGuidance ?? null,
    startupAttentionSeconds: result.startupAttentionSeconds,
    silentReminderSeconds: result.silentReminderSeconds,
    progressReminderSeconds: result.progressReminderSeconds,
    progressWrites: result.progressWrites,
    finalText: finalText.slice(0, 2048),
    finalTextTruncated: finalText.length > 2048,
    patchBytes: result.patchBytes,
    reviewPending: result.reviewPending,
    cleanupRequired: result.cleanupRequired,
    resultPath: join(runDirectory(root, result.runId), "result.json"),
    patchPath: result.patchPath,
    failureLogPath: result.failureLogPath,
    finishedAt: result.finishedAt,
  };
}

function reconcileVanished(root, ids) {
  const reconciled = [];
  for (const runId of ids) {
    const directory = runDirectory(root, runId);
    const observed = readJson(join(directory, "result.json"));
    if (!observed || terminal(observed) || !observed.supervisorPid || processAlive(observed.supervisorPid)) continue;
    try {
      withRunLock(directory, () => {
        const path = join(directory, "result.json");
        const current = readJson(path);
        if (!current || terminal(current) || processAlive(current.supervisorPid)) return;
        if (processAlive(current.childPid)) {
          stopPidTree(current.childPid, "SIGTERM");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
          if (processAlive(current.childPid)) stopPidTree(current.childPid, "SIGKILL");
        }
        rmSync(join(directory, "tmp"), { recursive: true, force: true });
        rmSync(join(directory, "agent"), { recursive: true, force: true });
        let patch = { patchPath: null, patchBytes: 0 };
        let patchError = null;
        try { patch = capturePatch(current, directory); } catch (error) { patchError = error.message; }
        const reason = "supervisor exited without a terminal result";
        const failureLogPath = join(directory, "failure.log");
        writeFileSync(failureLogPath, `${redactText([reason, patchError].filter(Boolean).join("\n\n"))}\n`, { mode: 0o600 });
        const started = Date.parse(current.startedAt ?? current.dispatchedAt ?? "");
        const previousAttentions = Array.isArray(current.attentions)
          ? [...current.attentions]
          : (current.attention ? [current.attention] : []);
        const writtenAttentions = attentionEvents(readJson(join(directory, "attention.json")));
        const merged = [...writtenAttentions];
        for (const entry of previousAttentions) {
          if (!merged.some((item) => attentionFingerprint(item.category, item.detail) === attentionFingerprint(entry.category, entry.detail))) merged.push(entry);
        }
        atomicJson(path, {
          ...current,
          schema: 3,
          state: "failed",
          activity: null,
          activeTools: [],
          reason,
          reasonCode: "supervisor_lost",
          attention: merged.at(-1) ?? null,
          attentions: merged,
          worker: current.worker ?? { version: WORKER_VERSION, brand: WORKER_BRAND },
          dispatcher: current.dispatcher ?? dispatcherFacts(),
          backendVersion: current.backendVersion ?? backendVersion(),
          exitCode: null,
          signal: null,
          ...patch,
          failureLogPath,
          reviewPending: current.mode !== "read",
          cleanupRequired: true,
          finishedAt: new Date().toISOString(),
          elapsedSeconds: Number.isFinite(started) ? Math.round((Date.now() - started) / 100) / 10 : null,
        });
        try { unlinkSync(join(directory, "cancel.json")); } catch {}
        reconciled.push(runId);
        notifyWaiter(directory);
      });
    } catch {
      // Another lifecycle operation owns this run; its next observation retries.
    }
  }
  return reconciled;
}

function statusView(result) {
  if (!result) return null;
  const last = Date.parse(result.lastEventAt ?? "");
  const activitySince = Date.parse(result.activitySince ?? "");
  return {
    ...result,
    supervisorAlive: !terminal(result) && processAlive(result.supervisorPid),
    childAlive: !terminal(result) && processAlive(result.childPid),
    eventAgeSeconds: Number.isFinite(last) ? Math.round((Date.now() - last) / 100) / 10 : null,
    activitySeconds: Number.isFinite(activitySince) ? Math.round((Date.now() - activitySince) / 100) / 10 : null,
  };
}

async function cancelRun(options) {
  const root = stateRoot(options);
  const ids = runIds(options);
  if (ids.length === 0) fail("cancel requires at least one --run-id");
  const timeoutSeconds = Number(one(options, "timeout", "15"));
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) fail("--timeout must be positive");
  const reason = redactText(one(options, "reason", "cancel requested")).slice(0, 512);
  for (const runId of ids) {
    const directory = runDirectory(root, runId);
    const result = readJson(join(directory, "result.json"));
    if (!result) fail(`unknown run: ${runId}`);
    if (terminal(result)) continue;
    atomicJson(join(directory, "cancel.json"), { reason, requestedAt: new Date().toISOString() });
    if (processAlive(result.supervisorPid)) {
      try { process.kill(result.supervisorPid, "SIGTERM"); } catch {}
    }
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    reconcileVanished(root, ids);
    if (currentResults(root, ids).every((item) => terminal(item.result))) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  reconcileVanished(root, ids);
  const results = currentResults(root, ids).map((item) => item.result);
  const pending = results.filter((result) => !terminal(result)).map((result) => result.runId);
  if (pending.length > 0) fail(`cancel timed out: ${pending.join(", ")}`, 3);
  for (const result of results) try { unlinkSync(join(runDirectory(root, result.runId), "cancel.json")); } catch {}
  const states = new Set(results.map((result) => result.state));
  const state = states.size === 1 ? results[0].state : "settled";
  console.log(JSON.stringify({ state, results }));
  if (results.some((result) => result.state === "failed")) process.exitCode = 3;
}

function pendingAttention(root, ids, consumer) {
  return ids.flatMap((runId) => {
    const directory = runDirectory(root, runId);
    const path = join(directory, "attention.json");
    return attentionEvents(readJson(path)).flatMap((attention) => {
      // The readiness check and the atomic claim must agree on the exact same
      // receipt file: attentionReceipt maps the default consumer onto the
      // legacy global path, so default claims are never split between a legacy
      // and a suffixed file (old receipts stay compatible), while any explicit
      // named consumer gets its own namespace and is never shadowed by a
      // legacy default receipt.
      const receipt = attentionReceipt(directory, attention, consumer);
      // A claimed delivery is a regular receipt file; a directory or any other
      // foreign object at that path is an IO fault, not a delivery, so the
      // alert stays ready and the claim surfaces the error instead of being
      // mistaken for already-notified.
      let claimed = false;
      try {
        claimed = existsSync(receipt) && statSync(receipt).isFile();
      } catch {
        claimed = false;
      }
      return !attention.delivered && !claimed
        ? [{ runId, receipt, attention }]
        : [];
    });
  });
}

function consumerFromOptions(options, env = process.env) {
  // An explicit --consumer wins; otherwise the available thread id is the
  // stable default, falling back to the literal default consumer. Both spell
  // the same scope (the legacy receipt namespace).
  const explicit = consumerName(one(options, "consumer"));
  if (explicit) return explicit === DEFAULT_CONSUMER ? DEFAULT_CONSUMER : explicit;
  const thread = env.CODEX_THREAD_ID || "";
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(thread)) return thread;
  return DEFAULT_CONSUMER;
}

async function waitForResults(options) {
  const root = stateRoot(options);
  const ids = runIds(options);
  if (ids.length === 0) fail("wait requires at least one --run-id");
  const timeoutSeconds = Number(one(options, "timeout", "0"));
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) fail("--timeout must be zero or positive");
  for (const id of ids) if (!existsSync(runDirectory(root, id))) fail(`unknown run: ${id}`);
  const full = one(options, "full") === "true";
  const consumer = consumerFromOptions(options);
  reconcileVanished(root, ids);
  const readyAttention = () => pendingAttention(root, ids, consumer);
  const terminalReady = () => currentResults(root, ids).some((item) => terminal(item.result));
  const claimReady = () => {
    // claimAttention returns null only when a concurrent twin claimed this
    // delivery first (EEXIST). Any other receipt IO failure is a real error:
    // it must fail the wait loudly instead of being misreported as notified.
    const claimedAny = [];
    for (const alert of readyAttention()) {
      try {
        const receipt = claimAttention(runDirectory(root, alert.runId), alert.attention, consumer);
        if (receipt) claimedAny.push({ ...alert, receipt });
      } catch (error) {
        // A real receipt IO fault (anything but a lost EEXIST race) must fail
        // this wait loudly; it is never reported as a delivered notification.
        throw new Error(`attention claim failed for ${alert.runId}: ${error.message}`);
      }
    }
    return claimedAny;
  };
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : null;
  let claimed = [];
  let turnResolve = null;
  let turnTimer = null;
  const wakeTurn = () => {
    const resolve = turnResolve;
    turnResolve = null;
    if (resolve) resolve();
  };
  const onSignal = () => wakeTurn();
  process.on("SIGUSR1", onSignal);
  let waiterPaths = [];
  const cleanupWaiters = () => {
    for (const path of waiterPaths) try { unlinkSync(path); } catch {}
    for (const directory of new Set(waiterPaths.map(dirname))) try { rmdirSync(directory); } catch {}
  };
  let fallback = null;
  let waitError = null;
  try {
    // Register this waiter once for the whole command; every wait turn reuses
    // the same slot so a waiter that loses a claim to a concurrent twin stays in
    // this wait (same overall deadline) until a terminal state or a delivery it
    // actually wins, never returning a fabricated "completed".
    waiterPaths = ids.map((id) => {
      const directory = eventDirectory(runDirectory(root, id));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${process.pid}.json`);
      atomicJson(path, { pid: process.pid, consumer, registeredAt: new Date().toISOString() });
      return path;
    });
    fallback = setInterval(() => {
      reconcileVanished(root, ids);
      if (turnResolve && (terminalReady() || readyAttention().length > 0)) wakeTurn();
    }, FALLBACK_MS);
    for (;;) {
      reconcileVanished(root, ids);
      if (terminalReady()) break;
      claimed = claimReady();
      if (claimed.length > 0) break;
      if (deadline !== null && Date.now() >= deadline) {
        waitError = new Error("wait timed out");
        break;
      }
      await new Promise((resolveTurn) => {
        turnResolve = resolveTurn;
        const remaining = deadline === null ? 0 : deadline - Date.now();
        if (remaining > 0) {
          turnTimer = setTimeout(() => {
            turnTimer = null;
            if (turnResolve) {
              turnResolve = null;
              resolveTurn();
            }
          }, remaining);
        }
      });
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
      turnResolve = null;
    }
  } catch (error) {
    waitError = error;
  } finally {
    cleanupWaiters();
    if (fallback) clearInterval(fallback);
    if (turnTimer) clearTimeout(turnTimer);
  }
  if (waitError) fail(waitError.message, 3);
  reconcileVanished(root, ids);
  const snapshot = currentResults(root, ids);
  const results = snapshot.filter((item) => terminal(item.result)).map((item) => full ? item.result : resultReceipt(root, item.result));
  const pending = snapshot.filter((item) => !terminal(item.result)).map((item) => item.runId);
  const failures = snapshot.filter((item) => ["failed", "cancelled"].includes(item.result?.state));
  const alerts = claimed;
  if (failures.length > 0) {
    console.log(JSON.stringify({
      state: "failed",
      results,
      alerts: alerts.map(({ runId, attention }) => ({ runId, ...attention })),
      pending,
    }));
    process.exitCode = 3;
    return;
  }
  if (alerts.length > 0 && pending.length > 0) {
    console.log(JSON.stringify({
      state: "attention",
      results,
      alerts: alerts.map(({ runId, attention }) => ({ runId, ...attention })),
      pending,
    }));
    process.exitCode = 4;
    return;
  }
  console.log(JSON.stringify({
    state: pending.length > 0 ? "completed" : "settled",
    results,
    alerts: alerts.map(({ runId, attention }) => ({ runId, ...attention })),
    pending,
  }));
}

function cleanup(options) {
  const root = stateRoot(options);
  const ids = runIds(options);
  if (ids.length === 0) fail("cleanup requires at least one --run-id");
  if (one(options, "reviewed") !== "yes") fail("cleanup requires --reviewed yes after Codex review");
  const cleaned = [];
  for (const runId of ids) {
    const directory = runDirectory(root, runId);
    const result = readJson(join(directory, "result.json"));
    if (!result) fail(`unknown run: ${runId}`);
    if (!terminal(result)) fail(`run is not finished: ${runId}`);
    let worktree;
    try {
      worktree = withRunLock(directory, () => {
        const current = readJson(join(directory, "result.json"));
        if (!terminal(current) || current.finishedAt !== result.finishedAt) throw new Error(`run changed before cleanup: ${runId}`);
        if (current.backend === "grok") cleanupGrokSession(current.grokSession);
        const removal = removeManagedWorktree(current, directory);
        if (removal.errors.length > 0 || (current.managedWorktree && !removal.removed)) {
          throw new Error(`worktree cleanup failed for ${runId}: ${removal.errors.join("; ")}`);
        }
        rmSync(directory, { recursive: true, force: true });
        rmSync(eventDirectory(directory), { recursive: true, force: true });
        return removal;
      });
    } catch (error) {
      fail(error.message, 3);
    }
    cleaned.push({ runId, worktreeRemoved: worktree.removed });
  }
  let cache;
  try { cache = cacheGc(root); } catch (error) { cache = { error: error.message }; }
  console.log(JSON.stringify({ cleaned, cache }));
}

function status(options) {
  const root = stateRoot(options);
  const ids = runIds(options);
  if (ids.length === 0) fail("status requires at least one --run-id");
  reconcileVanished(root, ids);
  console.log(JSON.stringify({ runs: currentResults(root, ids).map((item) => ({
    runId: item.runId,
    exists: Boolean(item.result),
    state: item.result?.state ?? "missing",
    result: statusView(item.result),
  })) }));
}

function diagnose(options) {
  const root = stateRoot(options);
  const ids = runIds(options);
  if (ids.length === 0) fail("diagnose requires at least one --run-id");
  console.log(JSON.stringify(diagnoseRuns(root, ids)));
}

const [command, ...argv] = process.argv.slice(2);
if (["help", "--help", "-h", undefined].includes(command)) {
  console.log(usage());
  process.exit(0);
}
const { options, passthrough } = parseArgs(argv);
if (command === "dispatch") dispatch(options, passthrough);
else if (command === "continue") continueRun(options, passthrough);
else if (command === "steer") await steerRun(options, passthrough);
else if (command === "cancel") await cancelRun(options);
else if (command === "supervise") await supervise(options, passthrough);
else if (command === "wait") await waitForResults(options);
else if (command === "cleanup") cleanup(options);
else if (command === "status") status(options);
else if (command === "diagnose") diagnose(options);
else if (command === "cache-status") console.log(JSON.stringify(cacheReport()));
else if (command === "profiles") console.log(JSON.stringify({
  backends: {
    pi: { capabilities: ["docs", "lens", "context", "browser"], live: true },
    agy: { efforts: AGY_PROFILES.efforts, defaultEffort: AGY_PROFILES.defaultEffort, live: false },
    claude: { efforts: CLAUDE_PROFILES.efforts, defaultEffort: CLAUDE_PROFILES.defaultEffort, live: false },
    grok: { ...GROK_PROFILES, live: false },
  },
  models: [...PROFILES].map(([id, profile]) => ({ id, ...profile })),
  capabilities: ["docs", "lens", "context", "browser"],
}));
else fail(usage());
