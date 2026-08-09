#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
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
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = join(tmpdir(), `pi-worker-${process.getuid?.() ?? "user"}`);
const FALLBACK_MS = 15_000;
const CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024;
const CACHE_STALE_MS = 90 * 24 * 60 * 60 * 1000;
const CACHE_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TAIL_BYTES = 64 * 1024;
const TOOL_ERROR_BYTES = 2 * 1024;
const STEER_MAX_BYTES = 16 * 1024;
const BASE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"];
const READ_TOOLS = ["read", "bash", "grep", "find", "ls", "web_search"];
const READ_ONLY_PROMPT = "This is a read-only task. Do not modify repository files. Use bash only for inspection or commands known not to write project files.";
const AGENT_PROFILE_FILES = ["auth.json", "models.json", "models-store.json", "settings.json"];
const OPTIONAL_PACKAGES = ["@upstash/context7-pi", "context-mode", "pi-lens", "pi-playwright"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PROFILES = new Map([
  ["opencode-go/deepseek-v4-flash", { defaultThinking: "max", allowed: ["high", "max"] }],
  ["deepseek/deepseek-v4-flash", { defaultThinking: "max", allowed: ["high", "max"] }],
  ["xai/grok-4.5", { defaultThinking: "high", allowed: ["low", "medium", "high"] }],
  ["krill/grok-4.5", { defaultThinking: "high", allowed: ["high"] }],
  ["shuaiapi-grok/grok-4.5", { defaultThinking: "high", allowed: ["high"] }],
  ["krill-sol/gpt-5.6-sol", { defaultThinking: "medium", allowed: ["low", "medium", "high", "xhigh", "max"] }],
  ["shuaiapi/gpt-5.6-sol", { defaultThinking: "medium", allowed: ["low", "medium", "high", "xhigh", "max"] }],
  ["shuaiapi/gpt-5.6-luna", { defaultThinking: "xhigh", allowed: ["low", "medium", "high", "xhigh", "max"] }],
]);
const ATTENTION_PATTERNS = [
  ["authentication", /(?:\b401\b|\b403\b|unauthori[sz]ed|invalid (?:api )?key|authentication failed)/i],
  ["rate_limit", /(?:\b429\b|rate[ -]?limit|too many requests)/i],
  ["provider_5xx", /(?:\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway timeout)/i],
  ["reasoning_ignored", /(?:(?:reasoning|thinking).*(?:ignored|unsupported|not supported)|(?:ignored|unsupported).*(?:reasoning|thinking))/i],
  ["transport", /(?:broken pipe|ECONNRESET|socket hang up|connection reset)/i],
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
    if (equal < 0 && name === "live") {
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
  return `pi-worker commands:
  dispatch --run-id ID [--mode read|write|in-place] [--source DIR|--workdir DIR]
           [--capability docs|lens|context|browser] [--live] [--idle-timeout SECONDS]
           [--hard-timeout SECONDS] -- --provider NAME --model ID [--thinking LEVEL] PROMPT
  continue --run-id ID [--live] [--idle-timeout SECONDS] -- PROMPT
  steer --run-id ID [--timeout SECONDS] -- MESSAGE
  cancel --run-id ID [--run-id ID...] [--reason TEXT] [--timeout SECONDS]
  wait --run-id ID [--run-id ID...] [--timeout SECONDS]
  cleanup --reviewed yes --run-id ID [--run-id ID...]
  status --run-id ID [--run-id ID...]
  cache-status
  profiles`;
}

function one(options, name, fallback = undefined) {
  return options.get(name)?.at(-1) ?? fallback;
}

function stateRoot(options) {
  return resolve(one(options, "state-root", process.env.PI_WORKER_STATE_ROOT ?? DEFAULT_ROOT));
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
  if (!prompt || prompt.startsWith("--")) fail("dispatch requires one prompt as the final Pi argument");
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
  const thinking = supplied.at(-1) ?? profile?.defaultThinking;
  if (!thinking) fail(`unknown Pi Worker profile ${key} requires explicit --thinking`);
  if (!THINKING_LEVELS.includes(thinking)) fail(`thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  if (profile && !profile.allowed.includes(thinking)) {
    fail(`${key} thinking must be one of: ${profile.allowed.join(", ")}`);
  }
  return {
    args: supplied.length > 0 ? piArgs : ["--thinking", profile.defaultThinking, ...piArgs],
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

function capturePatch(result, directory) {
  if (!result.managedWorktree) return { patchPath: null, patchBytes: 0 };
  runGit(result.workdir, ["add", "-A"]);
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
  const summary = { settled: false, lastAssistant: null, usage: {}, assistantCalls: 0, tools: [], playwrightUsed: false, consecutiveToolErrors: 0 };
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const event = JSON.parse(line);
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
        }
        summary.consecutiveToolErrors = error ? summary.consecutiveToolErrors + 1 : 0;
        if (summary.consecutiveToolErrors >= 3) onAttention("repeated_tool_errors", tool.lastError);
      }
      if (event.type === "auto_retry_start" && Number(event.attempt ?? 0) >= 2) onAttention("provider_retry", JSON.stringify(event));
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
    } catch {
      // Malformed output cannot prove completion, but does not need permanent storage.
    }
  }
  return summary;
}

function collectTail(stream, onActivity, onAttention) {
  return new Promise((resolveTail) => {
    let tail = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      onActivity(null);
      tail = (tail + chunk).slice(-FAILURE_TAIL_BYTES);
      const attention = classifyAttention(chunk);
      if (attention) onAttention(attention, chunk);
    });
    stream.on("end", () => resolveTail(tail.trim()));
  });
}

function notifyWaiter(directory) {
  const waiters = join(directory, "waiters");
  if (!existsSync(waiters)) return;
  for (const name of readdirSync(waiters).filter((entry) => entry.endsWith(".json"))) {
    const path = join(waiters, name);
    const waiter = readJson(path);
    if (!processAlive(waiter?.pid)) {
      try { unlinkSync(path); } catch {}
      continue;
    }
    try {
      process.kill(waiter.pid, "SIGUSR1");
    } catch {
      // result.json is durable; the fallback check still sees it.
    }
  }
}

function cacheCandidates() {
  const home = homedir();
  if (process.env.PI_WORKER_TEST_CACHE_ROOTS) {
    return process.env.PI_WORKER_TEST_CACHE_ROOTS.split(delimiter).map((path) => resolve(path));
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
    maxBytes: process.env.PI_WORKER_TEST_CACHE_ROOTS
      ? Number(process.env.PI_WORKER_CACHE_MAX_BYTES ?? CACHE_MAX_BYTES)
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

function pruneCacheFiles(before, actions) {
  const cutoff = Date.now() - CACHE_STALE_MS;
  const files = cacheCandidates().flatMap(cacheFiles).sort((left, right) => left.lastUsedMs - right.lastUsedMs);
  let estimatedBytes = before.totalBytes;
  for (const file of files) {
    if (file.lastUsedMs >= cutoff && estimatedBytes <= before.maxBytes) break;
    try {
      unlinkSync(file.path);
      estimatedBytes = Math.max(0, estimatedBytes - file.bytes);
      actions.push({ command: "cache file remove", path: file.path, bytes: file.bytes, stale: file.lastUsedMs < cutoff, exitCode: 0 });
    } catch (error) {
      actions.push({ command: "cache file remove", path: file.path, bytes: file.bytes, exitCode: 1, error: error.message });
    }
  }
}

function cacheGc(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const receiptPath = join(root, ".cache-gc.json");
  const previous = readJson(receiptPath);
  if (previous && Date.now() - Date.parse(previous.checkedAt) < CACHE_GC_INTERVAL_MS) {
    return { skipped: "checked within the last day", ...previous };
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
    pruneCacheFiles(before, actions);
    if (actions.length === 0 && before.totalBytes <= before.maxBytes) {
      const outcome = { checkedAt: new Date().toISOString(), before, after: before, actions, overLimit: false };
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
      actions.push({ command: `${command} ${args.join(" ")}`, exitCode: result.status });
    }
    const after = cacheReport();
    const outcome = { checkedAt: new Date().toISOString(), before, after, actions, overLimit: after.totalBytes > after.maxBytes };
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

function closePlaywrightSession(env, cwd) {
  const agentRoot = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const script = join(agentRoot, "npm", "node_modules", "pi-playwright", "skills", "playwright-browser", "scripts", "pw.js");
  if (!existsSync(script)) return null;
  const result = spawnSync(process.execPath, [script, "close"], { cwd, env, encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? null : (result.stderr || result.stdout || result.error?.message || "Playwright close failed").trim();
}

function prepareAgentProfile(directory) {
  const source = resolve(process.env.PI_WORKER_AGENT_SOURCE ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
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
  const live = initial.live === true;
  const { prompt, args: launchArgs } = extractPrompt(piArgs);
  const launcher = process.env.PI_WORKER_LAUNCHER ?? resolve(dirname(SCRIPT), "../bin/pi-worker");
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
  let summary = { settled: false, lastAssistant: null, usage: {}, assistantCalls: 0, tools: [], playwrightUsed: false };
  let stderr = "";
  let attention = initial.attention ?? null;
  const runEnv = {
    ...process.env,
    ...cacheEnvironment(),
    PI_CODING_AGENT_DIR: initial.agentDir ?? prepareAgentProfile(directory),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PLAYWRIGHT_CLI_SESSION: `pi-worker-${runId}`,
    PI_PLAYWRIGHT_ARTIFACTS: join(directory, "browser-artifacts"),
  };
  let idleTimer = null;
  let forceTimer = null;
  let rpcShutdownTimer = null;
  let steerFallback = null;
  let steerSignal = null;
  let cancelSignal = null;
  let hardTimeout = null;
  let child;
  const activeTools = new Map();
  let firstEventAt = initial.firstEventAt ?? null;
  const updateProgress = (event = undefined, forcedState = null) => {
    const current = readJson(resultPath);
    if (!current || terminal(current) || current.supervisorPid !== process.pid) return;
    const at = new Date().toISOString();
    if (event !== undefined) {
      firstEventAt ??= at;
      if (event?.type === "tool_execution_start") {
        const id = String(event.toolCallId ?? event.id ?? `${event.toolName ?? "tool"}-${at}`);
        activeTools.set(id, { id, name: event.toolName ?? null, startedAt: at });
      } else if (event?.type === "tool_execution_end") {
        const id = event.toolCallId ?? event.id;
        if (id !== undefined) activeTools.delete(String(id));
        else {
          const match = [...activeTools].find(([, tool]) => tool.name === (event.toolName ?? null));
          if (match) activeTools.delete(match[0]);
        }
      }
    }
    let state = forcedState ?? current.state;
    if (!forcedState && !["stopping", "finalizing"].includes(state)) {
      state = event?.type === "agent_settled" ? "finalizing" : "running";
    }
    const activity = ["stopping", "finalizing"].includes(state)
      ? null
      : (activeTools.size > 0 ? "running_tools" : (firstEventAt ? "waiting_model" : "waiting_event"));
    atomicJson(resultPath, {
      ...current,
      state,
      activity,
      firstEventAt,
      lastEventAt: event === undefined ? current.lastEventAt ?? null : at,
      activeTools: [...activeTools.values()].slice(0, 10),
    });
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
      resetIdle();
      updateProgress(event);
    };
    const markAttention = (category, detail) => {
      if (attention) return;
      attention = {
        category,
        detail: redactText(detail).slice(-4_096),
        detectedAt: new Date().toISOString(),
        delivered: false,
      };
      atomicJson(join(directory, "attention.json"), attention);
      notifyWaiter(directory);
    };
    const steerDir = join(directory, "steer");
    const ackDir = join(steerDir, "acks");
    const cancelPath = join(directory, "cancel.json");
    cancelSignal = () => {
      if (cancelRequested) return;
      const request = readJson(cancelPath);
      cancelRequested = true;
      cancelReason = request?.reason || "cancel requested";
      updateProgress(undefined, "stopping");
      stopChild();
    };
    process.off("SIGTERM", earlyCancelSignal);
    process.on("SIGTERM", cancelSignal);
    if (earlyCancelRequested || existsSync(cancelPath)) cancelSignal();
    if (live) mkdirSync(ackDir, { recursive: true, mode: 0o700 });
    child = spawn(launcher, live ? ["--mode", "rpc", ...launchArgs] : [...launchArgs, prompt], {
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
      if (!live) return;
      if (child.stdin.writable) child.stdin.end();
      rpcShutdownTimer = setTimeout(() => stopForTimeout("rpc_shutdown"), 5_000);
      rpcShutdownTimer.unref();
    };
    if (live && process.platform !== "win32") {
      steerSignal = () => drainSteer();
      process.on("SIGUSR2", steerSignal);
    }
    if (live) {
      steerFallback = setInterval(drainSteer, 5_000);
      steerFallback.unref();
    }
    atomicJson(resultPath, { ...readJson(resultPath), state: "running", activity: "waiting_event", supervisorPid: process.pid, childPid: child.pid });
    resetIdle();
    if (cancelRequested) {
      updateProgress(undefined, "stopping");
      stopChild();
    }
    const summaryPromise = summarizeStream(child.stdout, markActivity, markAttention, onResponse, onSettled);
    const stderrPromise = collectTail(child.stderr, markActivity, markAttention);
    hardTimeout = initial.hardTimeoutSeconds > 0 ? setTimeout(() => {
      stopForTimeout("hard");
    }, initial.hardTimeoutSeconds * 1000) : null;
    if (live) {
      sendRpc({ id: `prompt-${runId}`, type: "prompt", message: prompt });
      drainSteer();
    }
    ({ exitCode, signal, launchError } = await new Promise((resolveExit) => {
      child.once("error", (error) => resolveExit({ exitCode: null, signal: null, launchError: error.message }));
      child.once("close", (code, childSignal) => resolveExit({ exitCode: code, signal: childSignal, launchError: null }));
    }));
    updateProgress(undefined, "finalizing");
    [summary, stderr] = await Promise.all([summaryPromise, stderrPromise]);
  } catch (error) {
    launchError = error.message;
  } finally {
    if (hardTimeout) clearTimeout(hardTimeout);
    if (idleTimer) clearTimeout(idleTimer);
    if (forceTimer) clearTimeout(forceTimer);
    if (rpcShutdownTimer) clearTimeout(rpcShutdownTimer);
    if (steerFallback) clearInterval(steerFallback);
    if (steerSignal) process.off("SIGUSR2", steerSignal);
    if (cancelSignal) process.off("SIGTERM", cancelSignal);
    process.off("SIGTERM", earlyCancelSignal);
    if (child?.stdin?.writable) child.stdin.end();
    rmSync(tmp, { recursive: true, force: true });
  }

  const playwrightCleanupError = summary.playwrightUsed ? closePlaywrightSession(runEnv, initial.workdir) : null;
  rmSync(runEnv.PI_CODING_AGENT_DIR, { recursive: true, force: true });
  let patch = { patchPath: null, patchBytes: 0 };
  let patchError = null;
  try { patch = capturePatch(initial, directory); } catch (error) { patchError = error.message; }
  const assistantFailed = summary.lastAssistant?.stopReason === "error" || summary.lastAssistant?.error;
  const emptyFinal = !summary.lastAssistant?.text?.trim();
  const success = !cancelRequested && exitCode === 0 && summary.settled && !assistantFailed && !emptyFinal && !launchError && !timedOut && !patchError && !playwrightCleanupError;
  const reason = success ? null : (
    (cancelRequested ? cancelReason : null) ?? patchError ?? playwrightCleanupError ?? launchError
    ?? (timedOut ? `${timeoutType} timeout` : null) ?? summary.lastAssistant?.error
    ?? (!summary.settled ? "missing agent_settled" : null) ?? (emptyFinal ? "empty final response" : `exit ${exitCode}`)
  );
  const reasonCode = success ? null : (
    cancelRequested ? "user_cancelled"
      : patchError ? "patch_error"
        : playwrightCleanupError ? "cleanup_error"
          : launchError ? "launch_error"
            : timedOut ? `${timeoutType}_timeout`
              : summary.lastAssistant?.error ? "provider_error"
                : !summary.settled ? "missing_settled"
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
    activeTools: [],
    exitCode,
    signal,
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
    usage: summary.usage,
    assistantCalls: summary.assistantCalls,
    reportedReasoningTokens: Number.isFinite(summary.usage?.reasoning) ? summary.usage.reasoning : null,
    tools: summary.tools,
    attention,
    ...patch,
    failureLogPath,
    reviewPending: initial.mode !== "read",
    cleanupRequired: true,
    finishedAt: new Date().toISOString(),
    elapsedSeconds: Math.round((Date.now() - startedMs) / 100) / 10,
  });
  try { unlinkSync(join(directory, "cancel.json")); } catch {}
  notifyWaiter(directory);
}

function startSupervisor(root, runId, piArgs) {
  const supervisor = spawn(
    process.execPath,
    [SCRIPT, "supervise", "--run-id", runId, "--state-root", root, "--", ...piArgs],
    { detached: true, env: { ...process.env, PI_WORKER_STATE_ROOT: root }, stdio: "ignore" },
  );
  supervisor.unref();
  return supervisor.pid;
}

function dispatch(options, piArgs) {
  const root = stateRoot(options);
  const runId = validateRunId(one(options, "run-id"));
  const mode = one(options, "mode", one(options, "source") ? "write" : "read");
  if (!["read", "write", "in-place"].includes(mode)) fail("--mode must be read, write, or in-place");
  if (piArgs.length === 0) fail("dispatch requires Pi arguments after --");
  const selection = applyDispatchProfile(piArgs);
  const capabilities = options.get("capability") ?? [];
  const taskArgs = mode === "read" ? ["--append-system-prompt", READ_ONLY_PROMPT, ...selection.args] : selection.args;
  const effectiveArgs = applyCapabilities(taskArgs, capabilities, mode === "read" ? READ_TOOLS : BASE_TOOLS);
  const hardTimeoutSeconds = Number(one(options, "hard-timeout", "0"));
  if (!Number.isFinite(hardTimeoutSeconds) || hardTimeoutSeconds < 0) fail("--hard-timeout must be zero or positive");
  const idleTimeoutSeconds = Number(one(options, "idle-timeout", "0"));
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds < 0) fail("--idle-timeout must be zero or positive");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = runDirectory(root, runId);
  if (existsSync(directory)) fail(`run already exists: ${runId}`);
  mkdirSync(directory, { mode: 0o700 });
  const sessionDir = join(directory, "session");

  let workspace;
  let agentDir;
  try {
    agentDir = prepareAgentProfile(directory);
    mkdirSync(sessionDir, { mode: 0o700 });
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
    state: "starting",
    activity: "waiting_event",
    mode,
    sourceRoot: workspace.sourceRoot,
    workdir: workspace.worktree,
    managedWorktree: workspace.managedWorktree,
    sessionDir,
    agentDir,
    turnIndex: 1,
    firstEventAt: null,
    lastEventAt: null,
    activeTools: [],
    baseCommit: workspace.baseCommit,
    baselineTree: workspace.baselineTree,
    provider: selection.provider,
    model: selection.model,
    thinking: selection.thinking,
    capabilities,
    live: options.has("live"),
    hardTimeoutSeconds,
    idleTimeoutSeconds,
    dispatchedAt: new Date().toISOString(),
  });
  const supervisorPid = startSupervisor(root, runId, ["--session-dir", sessionDir, ...effectiveArgs]);
  atomicJson(join(directory, "result.json"), { ...readJson(join(directory, "result.json")), supervisorPid });
  console.log(JSON.stringify({ runId, state: "running", mode, live: options.has("live"), supervisorPid, workdir: workspace.worktree, sessionDir, directory }));
}

function continueRun(options, promptArgs) {
  const root = stateRoot(options);
  const runId = validateRunId(one(options, "run-id"));
  const directory = runDirectory(root, runId);
  const resultPath = join(directory, "result.json");
  const previous = readJson(resultPath);
  if (!terminal(previous)) fail(`run is not ready to continue: ${runId}`);
  if (promptArgs.length === 0) fail("continue requires a prompt after --");
  if (!previous.sessionDir || !existsSync(previous.sessionDir)) fail(`managed session is unavailable: ${runId}`);
  if (!existsSync(previous.workdir)) fail(`worker directory is unavailable: ${previous.workdir}`);
  const selection = applyDispatchProfile([
    "--provider", previous.provider,
    "--model", previous.model,
    "--thinking", previous.thinking,
    ...promptArgs,
  ]);
  const taskArgs = previous.mode === "read" ? ["--append-system-prompt", READ_ONLY_PROMPT, "--continue", ...selection.args] : ["--continue", ...selection.args];
  const effectiveArgs = applyCapabilities(taskArgs, previous.capabilities ?? [], previous.mode === "read" ? READ_TOOLS : BASE_TOOLS);
  const idleTimeoutSeconds = Number(one(options, "idle-timeout", String(previous.idleTimeoutSeconds ?? 0)));
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds < 0) fail("--idle-timeout must be zero or positive");
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
    finishedAt: previous.finishedAt,
  }];
  let supervisorPid;
  try {
    supervisorPid = withRunLock(directory, () => {
      const current = readJson(resultPath);
      if (!terminal(current) || current.finishedAt !== previous.finishedAt) throw new Error(`run changed before continuation: ${runId}`);
      const agentDir = prepareAgentProfile(directory);
      atomicJson(resultPath, {
        ...previous,
        state: "starting",
        activity: "waiting_event",
        supervisorPid: null,
        childPid: null,
        agentDir,
        turnIndex: (previous.turnIndex ?? 1) + 1,
        turns,
        firstEventAt: null,
        lastEventAt: null,
        activeTools: [],
        exitCode: null,
        signal: null,
        agentSettled: false,
        reason: null,
        reasonCode: null,
        timeoutType: null,
        finalText: "",
        usage: null,
        tools: [],
        attention: null,
        live: options.has("live"),
        idleTimeoutSeconds,
        failureLogPath: null,
        dispatchedAt: new Date().toISOString(),
        finishedAt: null,
      });
      try { unlinkSync(join(directory, "attention.json")); } catch {}
      try { unlinkSync(join(directory, "failure.log")); } catch {}
      const pid = startSupervisor(root, runId, ["--session-dir", previous.sessionDir, ...effectiveArgs]);
      atomicJson(resultPath, { ...readJson(resultPath), supervisorPid: pid });
      return pid;
    });
  } catch (error) {
    fail(error.message, 3);
  }
  console.log(JSON.stringify({ runId, state: "running", mode: previous.mode, live: options.has("live"), turnIndex: (previous.turnIndex ?? 1) + 1, supervisorPid, workdir: previous.workdir, sessionDir: previous.sessionDir, directory }));
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
        atomicJson(path, {
          ...current,
          schema: 3,
          state: "failed",
          activity: null,
          activeTools: [],
          reason,
          reasonCode: "supervisor_lost",
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
  return {
    ...result,
    supervisorAlive: !terminal(result) && processAlive(result.supervisorPid),
    childAlive: !terminal(result) && processAlive(result.childPid),
    eventAgeSeconds: Number.isFinite(last) ? Math.round((Date.now() - last) / 100) / 10 : null,
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

function pendingAttention(root, ids) {
  return ids.flatMap((runId) => {
    const path = join(runDirectory(root, runId), "attention.json");
    const attention = readJson(path);
    return attention && !attention.delivered ? [{ runId, path, attention }] : [];
  });
}

async function waitForResults(options) {
  const root = stateRoot(options);
  const ids = runIds(options);
  if (ids.length === 0) fail("wait requires at least one --run-id");
  const timeoutSeconds = Number(one(options, "timeout", "0"));
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) fail("--timeout must be zero or positive");
  for (const id of ids) if (!existsSync(runDirectory(root, id))) fail(`unknown run: ${id}`);
  reconcileVanished(root, ids);
  const terminalReady = () => currentResults(root, ids).some((item) => terminal(item.result));
  const attentionReady = () => pendingAttention(root, ids).length > 0;
  if (!terminalReady() && !attentionReady()) {
    await new Promise((resolveWait, rejectWait) => {
      let finished = false;
      const fallback = setInterval(check, FALLBACK_MS);
      const timeout = timeoutSeconds > 0 ? setTimeout(() => finish(new Error("wait timed out")), timeoutSeconds * 1000) : null;
      process.on("SIGUSR1", check);
      const waiterPaths = ids.map((id) => {
        const directory = join(runDirectory(root, id), "waiters");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${process.pid}.json`);
        atomicJson(path, { pid: process.pid, registeredAt: new Date().toISOString() });
        return path;
      });
      function finish(error = null) {
        if (finished) return;
        finished = true;
        clearInterval(fallback);
        if (timeout) clearTimeout(timeout);
        for (const path of waiterPaths) try { unlinkSync(path); } catch {}
        error ? rejectWait(error) : resolveWait();
      }
      function check() {
        if (finished) return;
        reconcileVanished(root, ids);
        if (terminalReady() || attentionReady()) return finish();
      }
      check();
    }).catch((error) => fail(error.message, 3));
  }
  reconcileVanished(root, ids);
  const snapshot = currentResults(root, ids);
  const results = snapshot.filter((item) => terminal(item.result)).map((item) => item.result);
  const pending = snapshot.filter((item) => !terminal(item.result)).map((item) => item.runId);
  const failures = snapshot.filter((item) => ["failed", "cancelled"].includes(item.result?.state));
  const alerts = pendingAttention(root, ids);
  for (const alert of alerts) atomicJson(alert.path, { ...alert.attention, delivered: true, deliveredAt: new Date().toISOString() });
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
        const removal = removeManagedWorktree(current, directory);
        if (removal.errors.length > 0 || (current.managedWorktree && !removal.removed)) {
          throw new Error(`worktree cleanup failed for ${runId}: ${removal.errors.join("; ")}`);
        }
        rmSync(directory, { recursive: true, force: true });
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
  console.log(JSON.stringify({ runs: currentResults(root, ids).map((item) => ({ ...item, result: statusView(item.result) })) }));
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
else if (command === "cache-status") console.log(JSON.stringify(cacheReport()));
else if (command === "profiles") console.log(JSON.stringify({
  models: [...PROFILES].map(([id, profile]) => ({ id, ...profile })),
  capabilities: ["docs", "lens", "context", "browser"],
}));
else fail(usage());
