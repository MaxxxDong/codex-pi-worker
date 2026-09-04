import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const events = join(root, "lib/events.mjs");
const THINKING_LEVELS_FOR_TEST = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function command(args, env, allowFailure = false) {
  const result = spawnSync(process.execPath, [events, ...args], { encoding: "utf8", env });
  if (!allowFailure && result.status !== 0) throw new Error(result.stderr || result.stdout);
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

function commandAsync(args, env) {
  return new Promise((resolveCommand) => {
    const child = spawn(process.execPath, [events, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolveCommand({ status, stderr, json: stdout ? JSON.parse(stdout) : null }));
  });
}

function waitAll(ids, env) {
  const byId = new Map();
  let pending = ids;
  while (pending.length > 0) {
    const waited = command(["wait", "--full", ...pending.flatMap((id) => ["--run-id", id]), "--timeout", "10"], env).json;
    for (const result of waited.results) byId.set(result.runId, result);
    pending = waited.pending;
  }
  return ids.map((id) => byId.get(id));
}

function testEnv(temporary, launcher) {
  const caches = [join(temporary, ".npm"), join(temporary, ".cache", "uv")];
  caches.forEach((path) => mkdirSync(path, { recursive: true }));
  const agent = join(temporary, "agent-source");
  mkdirSync(join(agent, "npm"), { recursive: true });
  for (const name of ["auth.json", "models.json", "models-store.json", "settings.json"]) {
    writeFileSync(join(agent, name), "{}\n");
  }
  return {
    ...process.env,
    PI_WORKER_STATE_ROOT: join(temporary, "state"),
    PI_WORKER_LAUNCHER: launcher,
    PI_WORKER_AGENT_SOURCE: agent,
    PI_WORKER_TEST_CACHE_ROOTS: caches.join(delimiter),
    PI_WORKER_CACHE_MAX_BYTES: String(1024 * 1024),
  };
}

function fakeLauncher(temporary, body) {
  const path = join(temporary, `fake-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

const successEvents = `
console.log(JSON.stringify({type:"argv",argv:process.argv.slice(2)}));
await new Promise((resolve) => setTimeout(resolve, 100));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:"DONE"}],usage:{input:1,output:1}}}));
console.log(JSON.stringify({type:"agent_settled"}));`;

test("workers use a run-local writable Pi profile with shared packages", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-agent-profile-"));
  const marker = join(temporary, "profile.json");
  const fake = fakeLauncher(temporary, `
import {readFileSync, readlinkSync, writeFileSync} from "node:fs";
import {join} from "node:path";
const agent = process.env.PI_CODING_AGENT_DIR;
writeFileSync(process.env.PI_WORKER_TEST_PROFILE_MARKER, JSON.stringify({
  agent,
  auth: JSON.parse(readFileSync(join(agent, "auth.json"), "utf8")),
  settings: JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")),
  npm: readlinkSync(join(agent, "npm")),
}));
${successEvents}`);
  const env = testEnv(temporary, fake);
  env.PI_WORKER_TEST_PROFILE_MARKER = marker;
  writeFileSync(join(env.PI_WORKER_AGENT_SOURCE, "auth.json"), '{"provider":"configured"}\n');
  writeFileSync(join(env.PI_WORKER_AGENT_SOURCE, "settings.json"), JSON.stringify({
    defaultProvider: "commandcode",
    defaultModel: "Qwen/Qwen3.8-Flash",
    enabledModels: ["commandcode/Qwen/Qwen3.8-Flash"],
    skills: ["coding"],
    packages: ["npm:pi-lens", "npm:pi-playwright", "npm:context-mode", "npm:@upstash/context7-pi", "npm:keep-me"],
  }));
  try {
    command(["dispatch", "--run-id", "profile", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    const result = command(["wait", "--full", "--run-id", "profile", "--timeout", "10"], env).json.results[0];
    assert.equal(result.hardTimeoutSeconds, 0);
    assert.equal(result.idleTimeoutSeconds, 0);
    const profile = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(profile.agent, join(env.PI_WORKER_STATE_ROOT, "profile", "agent"));
    assert.deepEqual(profile.auth, { provider: "configured" });
    assert.deepEqual(profile.settings, { skills: ["coding"], packages: ["npm:keep-me"] });
    assert.equal(profile.npm, join(env.PI_WORKER_AGENT_SOURCE, "npm"));
    assert.ok(!existsSync(profile.agent));
    command(["cleanup", "--reviewed", "yes", "--run-id", "profile"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("parallel read workers return independently and retain only compact results", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-read-"));
  const fake = fakeLauncher(temporary, successEvents);
  const env = testEnv(temporary, fake);
  try {
    for (const [id, provider, model] of [["one", "commandcode", "google/gemini-3.7-flash"], ["two", "commandcode", "z-ai/glm-5.3-flash"], ["three", "deepseek", "deepseek-v4-flash"], ["four", "xai", "grok-4.5"]]) {
      command(["dispatch", "--run-id", id, "--mode", "read", "--workdir", temporary, "--", "--provider", provider, "--model", model], env);
    }
    const results = waitAll(["one", "two", "three", "four"], env);
    assert.deepEqual(results.map((result) => result.state), ["success", "success", "success", "success"]);
    assert.deepEqual(results.map((result) => result.thinking), ["high", "max", "max", "high"]);
    assert.ok(results.every((result) => result.finalText === "DONE"));
    assert.ok(!existsSync(join(env.PI_WORKER_STATE_ROOT, "one", "worker.jsonl")));
    assert.ok(!existsSync(join(env.PI_WORKER_STATE_ROOT, "one", "worker.stderr")));
    command(["cleanup", "--reviewed", "yes", "--run-id", "one", "--run-id", "two", "--run-id", "three", "--run-id", "four"], env);
    assert.ok(!existsSync(join(env.PI_WORKER_STATE_ROOT, "one")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("wait returns when one run succeeds while peers continue", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-success-fast-"));
  const fake = fakeLauncher(temporary, `
const prompt = process.argv.at(-1);
await new Promise((resolve) => setTimeout(resolve, prompt === "fast" ? 100 : 1200));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "fast-success", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "fast"], env);
    command(["dispatch", "--run-id", "slow-success", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "slow"], env);
    const started = Date.now();
    const first = command(["wait", "--full", "--run-id", "fast-success", "--run-id", "slow-success", "--timeout", "10"], env).json;
    assert.equal(first.state, "completed");
    assert.deepEqual(first.results.map((result) => result.runId), ["fast-success"]);
    assert.deepEqual(first.pending, ["slow-success"]);
    assert.ok(Date.now() - started < 1000);
    assert.equal(command(["wait", "--full", "--run-id", "slow-success", "--timeout", "10"], env).json.state, "settled");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("independent waiters on the same run are both notified", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-multi-waiter-"));
  const fake = fakeLauncher(temporary, `
await new Promise((resolve) => setTimeout(resolve, 500));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "shared", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    const args = ["wait", "--run-id", "shared", "--timeout", "3"];
    const [first, second] = await Promise.all([commandAsync(args, env), commandAsync(args, env)]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.json.results[0].state, "success");
    assert.equal(second.json.results[0].state, "success");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("wait returns a compact receipt and full output only on request", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-compact-wait-"));
  const fake = fakeLauncher(temporary, successEvents);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "compact", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    const receipt = command(["wait", "--run-id", "compact", "--timeout", "10"], env).json.results[0];
    assert.equal(receipt.finalText, "DONE");
    assert.equal(receipt.sourceRoot, undefined);
    assert.equal(receipt.tools[0]?.lastError, undefined);
    assert.equal(receipt.resultPath, join(env.PI_WORKER_STATE_ROOT, "compact", "result.json"));
    const full = command(["wait", "--full", "--run-id", "compact", "--timeout", "10"], env).json.results[0];
    assert.equal(full.sourceRoot, temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("status distinguishes a missing run", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-missing-status-"));
  const env = testEnv(temporary, "/missing");
  try {
    const run = command(["status", "--run-id", "absent"], env).json.runs[0];
    assert.deepEqual(run, { runId: "absent", exists: false, state: "missing", result: null });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("usage aggregates every assistant call", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-usage-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"toolUse",content:[{type:"text",text:"STEP"}],usage:{input:10,output:2,cacheRead:5,reasoning:3,totalTokens:20,cost:{input:1,total:2}}}}));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:"DONE"}],usage:{input:20,output:4,cacheRead:7,reasoning:6,totalTokens:40,cost:{input:3,total:4}}}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "usage", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    const result = command(["wait", "--full", "--run-id", "usage", "--timeout", "10"], env).json.results[0];
    assert.equal(result.finalText, "DONE");
    assert.deepEqual(result.usage, { input: 30, output: 6, cacheRead: 12, reasoning: 9, totalTokens: 60, cost: { input: 4, total: 6 } });
    assert.equal(result.assistantCalls, 2);
    assert.equal(result.reportedReasoningTokens, 9);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("failure produces a bounded failure log", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-failure-"));
  const fake = fakeLauncher(temporary, 'process.stderr.write("diagnostic Authorization: Bearer sk-secret0123456789012345\\n"); console.log(JSON.stringify({type:"agent_end"}));');
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "failed", "--workdir", temporary, "--", "--provider", "xai", "--model", "grok-4.5"], env);
    const waited = command(["wait", "--full", "--run-id", "failed", "--timeout", "10"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results[0].reason, "missing agent_settled");
    const log = readFileSync(join(env.PI_WORKER_STATE_ROOT, "failed", "failure.log"), "utf8");
    assert.match(log, /diagnostic/);
    assert.doesNotMatch(log, /sk-secret/);
    assert.match(log, /\[REDACTED\]/);
    assert.ok(!existsSync(join(env.PI_WORKER_STATE_ROOT, "failed", "changes.patch")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("settled reasoning without visible final text fails explicitly", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-empty-final-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"thinking",thinking:"internal only"}],usage:{input:1,output:1,reasoning:1}}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "empty", "--workdir", temporary, "--", "--provider", "xai", "--model", "grok-4.5"], env);
    const waited = command(["wait", "--full", "--run-id", "empty", "--timeout", "10"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results[0].reason, "empty final response");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("dispatch requires an explicit model, supplies defaults, and accepts caller thinking", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-profile-"));
  const env = testEnv(temporary, fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify(process.argv.slice(2))}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`));
  try {
    const implicit = command(["dispatch", "--run-id", "implicit", "--workdir", temporary, "--", "task"], env, true);
    assert.equal(implicit.status, 2);
    assert.match(implicit.stderr, /--provider, --model/);
    command(["dispatch", "--run-id", "xai-medium", "--workdir", temporary, "--", "--provider", "xai", "--model", "grok-4.5", "--thinking", "medium", "task"], env);
    const xaiGrok = command(["wait", "--full", "--run-id", "xai-medium", "--timeout", "10"], env).json.results[0];
    assert.equal(xaiGrok.thinking, "medium");
    const session = command(["dispatch", "--run-id", "session", "--workdir", temporary, "--", "--provider", "commandcode", "--model", "google/gemini-3.7-flash", "--resume", "abc"], env, true);
    assert.equal(session.status, 2);
    assert.match(session.stderr, /owns its managed session/);
    const sol = command(["dispatch", "--run-id", "sol", "--workdir", temporary, "--", "--provider", "commandcode", "--model", "google/gemini-3.7-flash", "--thinking", "invalid"], env, true);
    assert.equal(sol.status, 2);
    assert.match(sol.stderr, /thinking must be one of/);
    const deepseek = command(["dispatch", "--run-id", "deepseek-low", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "--thinking", "low", "task"], env, true);
    assert.equal(deepseek.status, 0);
    const selected = command(["wait", "--full", "--run-id", "deepseek-low", "--timeout", "10"], env).json.results[0];
    const selectedArgs = JSON.parse(selected.finalText);
    assert.equal(selected.thinking, "low");
    assert.deepEqual(selectedArgs.filter((argument) => argument === "--thinking" || THINKING_LEVELS_FOR_TEST.has(argument)), ["--thinking", "low"]);
    command(["dispatch", "--run-id", "official-low", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "--thinking", "low", "task"], env);
    const unknownImplicit = command(["dispatch", "--run-id", "unknown-implicit", "--workdir", temporary, "--", "--provider", "new-provider", "--model", "new-model", "task"], env, true);
    assert.equal(unknownImplicit.status, 2);
    assert.match(unknownImplicit.stderr, /requires explicit --thinking/);
    command(["dispatch", "--run-id", "unknown", "--workdir", temporary, "--", "--provider", "new-provider", "--model", "new-model", "--thinking", "high", "task"], env);
    const unknown = command(["wait", "--full", "--run-id", "unknown", "--timeout", "10"], env).json.results[0];
    assert.equal(unknown.provider, "new-provider");
    assert.equal(unknown.model, "new-model");
    assert.equal(unknown.thinking, "high");
    const commandcodeExtension = join(env.PI_WORKER_AGENT_SOURCE, "extensions", "commandcode.ts");
    mkdirSync(resolve(commandcodeExtension, ".."), { recursive: true });
    writeFileSync(commandcodeExtension, "// test provider extension\n");
    command(["dispatch", "--run-id", "commandcode", "--workdir", temporary, "--", "--provider", "commandcode", "--model", "z-ai/glm-5.3-flash", "--thinking", "max", "task"], env);
    const commandcode = command(["wait", "--full", "--run-id", "commandcode", "--timeout", "10"], env).json.results[0];
    const commandcodeArgs = JSON.parse(commandcode.finalText);
    const extension = commandcodeArgs.indexOf("--extension");
    assert.equal(commandcodeArgs[extension + 1], commandcodeExtension);
    command(["dispatch", "--run-id", "qwen-flash", "--workdir", temporary, "--", "--provider", "commandcode", "--model", "Qwen/Qwen3.8-Flash", "task"], env);
    const qwen = command(["wait", "--full", "--run-id", "qwen-flash", "--timeout", "10"], env).json.results[0];
    assert.equal(qwen.thinking, "max");
    command(["cleanup", "--reviewed", "yes", "--run-id", "xai-medium", "--run-id", "deepseek-low", "--run-id", "official-low", "--run-id", "unknown", "--run-id", "commandcode", "--run-id", "qwen-flash"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("provider attention wakes wait immediately and does not prevent a later terminal wait", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-attention-"));
  const fake = fakeLauncher(temporary, `
process.stderr.write("HTTP 429 too many requests\\n");
await new Promise((resolve) => setTimeout(resolve, 500));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "attention", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    const alert = command(["wait", "--full", "--run-id", "attention", "--timeout", "10"], env, true);
    assert.equal(alert.status, 4);
    assert.equal(alert.json.state, "attention");
    assert.equal(alert.json.alerts[0].category, "rate_limit");
    assert.deepEqual(alert.json.pending, ["attention"]);
    const terminal = command(["wait", "--full", "--run-id", "attention", "--timeout", "10"], env).json;
    assert.equal(terminal.results[0].state, "success");
    assert.equal(terminal.results[0].attention.category, "rate_limit");
    assert.deepEqual(terminal.alerts, []);
    assert.equal(existsSync(join(env.PI_WORKER_STATE_ROOT, "attention", "waiters")), false);
    command(["cleanup", "--reviewed", "yes", "--run-id", "attention"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("distinct attention events are delivered once and in order", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-attention-sequence-"));
  const fake = fakeLauncher(temporary, `
process.stderr.write("HTTP 429 too many requests\\n");
await new Promise((resolve) => setTimeout(resolve, 250));
console.log(JSON.stringify({type:"extension_error",error:"extension failed"}));
await new Promise((resolve) => setTimeout(resolve, 250));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "attention-sequence", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    const first = command(["wait", "--full", "--run-id", "attention-sequence", "--timeout", "10"], env, true);
    assert.equal(first.status, 4);
    assert.deepEqual(first.json.alerts.map((alert) => alert.category), ["rate_limit"]);
    const second = command(["wait", "--full", "--run-id", "attention-sequence", "--timeout", "10"], env, true);
    assert.equal(second.status, 4);
    assert.deepEqual(second.json.alerts.map((alert) => alert.category), ["extension_error"]);
    const terminal = command(["wait", "--full", "--run-id", "attention-sequence", "--timeout", "10"], env).json;
    assert.equal(terminal.results[0].state, "success");
    assert.deepEqual(terminal.results[0].attentions.map((alert) => alert.category), ["rate_limit", "extension_error"]);
    assert.deepEqual(terminal.alerts, []);
    command(["cleanup", "--reviewed", "yes", "--run-id", "attention-sequence"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a silent startup raises attention without stopping the worker", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-startup-silent-"));
  const fake = fakeLauncher(temporary, `
await new Promise((resolve) => setTimeout(resolve, 500));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "startup-silent", "--workdir", temporary, "--startup-attention", "0.15", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    const alert = command(["wait", "--full", "--run-id", "startup-silent", "--timeout", "10"], env, true);
    assert.equal(alert.status, 4);
    assert.equal(alert.json.alerts[0].category, "startup_silent");
    assert.deepEqual(alert.json.pending, ["startup-silent"]);
    const terminal = command(["wait", "--full", "--run-id", "startup-silent", "--timeout", "10"], env).json;
    assert.equal(terminal.results[0].state, "success");
    assert.equal(terminal.results[0].startupAttentionSeconds, 0.15);
    command(["cleanup", "--reviewed", "yes", "--run-id", "startup-silent"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("high frequency stream activity is durably throttled", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-progress-throttle-"));
  const fake = fakeLauncher(temporary, `
for (let index = 0; index < 500; index += 1) console.log(JSON.stringify({type:"message_update",index}));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "progress-throttle", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    const result = command(["wait", "--full", "--run-id", "progress-throttle", "--timeout", "10"], env).json.results[0];
    assert.equal(result.state, "success");
    assert.ok(result.progressWrites > 0);
    assert.ok(result.progressWrites <= 10, `expected at most 10 progress writes, got ${result.progressWrites}`);
    command(["cleanup", "--reviewed", "yes", "--run-id", "progress-throttle"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("deterministic provider rejection raises attention on the first error", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-rejected-"));
  const fake = fakeLauncher(temporary, `
process.stderr.write("DataInspectionFailed: Input text data may contain inappropriate content\\n");
await new Promise((resolve) => setTimeout(resolve, 500));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "rejected", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    const alert = command(["wait", "--full", "--run-id", "rejected", "--timeout", "10"], env, true);
    assert.equal(alert.status, 4);
    assert.equal(alert.json.alerts[0].category, "request_rejected");
    command(["wait", "--full", "--run-id", "rejected", "--timeout", "10"], env);
    command(["cleanup", "--reviewed", "yes", "--run-id", "rejected"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("three identical consecutive tool failures wake wait with bounded redacted summaries", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-tool-errors-"));
  const fake = fakeLauncher(temporary, `
for (let index = 0; index < 3; index += 1) console.log(JSON.stringify({type:"tool_execution_end",toolName:"read",isError:true,result:{content:[{type:"text",text:"Authorization: Bearer sk-secret0123456789012345 " + "x".repeat(5000)}]}}));
await new Promise((resolve) => setTimeout(resolve, 1000));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "tool-errors", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    const alert = command(["wait", "--full", "--run-id", "tool-errors", "--timeout", "10"], env, true);
    assert.equal(alert.status, 4);
    assert.equal(alert.json.alerts[0].category, "repeated_tool_errors");
    const result = command(["wait", "--full", "--run-id", "tool-errors", "--timeout", "10"], env).json.results[0];
    assert.deepEqual(result.tools.map(({ name, count, errorCount }) => ({ name, count, errorCount })), [
      { name: "read", count: 3, errorCount: 3 },
    ]);
    assert.ok(result.tools[0].lastError.length <= 2048);
    assert.ok(!result.tools[0].lastError.includes("sk-secret"));
    command(["cleanup", "--reviewed", "yes", "--run-id", "tool-errors"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("different failing probes remain observable without raising repeated-error attention", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-tool-probes-"));
  const fake = fakeLauncher(temporary, [
    "for (let index = 0; index < 3; index += 1) console.log(JSON.stringify({type:\"tool_execution_end\",toolName:\"bash\",isError:true,result:{content:[{type:\"text\",text:\"expected probe \" + index}]}}));",
    successEvents,
  ].join("\n"));
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "tool-probes", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    const result = command(["wait", "--full", "--run-id", "tool-probes", "--timeout", "10"], env).json.results[0];
    assert.equal(result.state, "success");
    assert.equal(result.attention, null);
    assert.deepEqual(result.tools.map(({ name, count, errorCount }) => ({ name, count, errorCount })), [
      { name: "bash", count: 3, errorCount: 3 },
    ]);
    command(["cleanup", "--reviewed", "yes", "--run-id", "tool-probes"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("RPC steer is acknowledged and changes the active turn without continuation", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-steer-"));
  const fake = fakeLauncher(temporary, `
import {createInterface} from "node:readline";
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const value = JSON.parse(line);
  console.log(JSON.stringify({type:"response",id:value.id,success:true}));
  if (value.type === "steer") {
    console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:"STEERED:" + value.message}]}}));
    console.log(JSON.stringify({type:"agent_settled"}));
    break;
  }
}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "steer", "--workdir", temporary, "--live", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "start"], env);
    const ack = command(["steer", "--run-id", "steer", "--timeout", "10", "--", "focus on boundary tests"], env).json;
    assert.equal(ack.success, true);
    const result = command(["wait", "--full", "--run-id", "steer", "--timeout", "10"], env).json.results[0];
    assert.equal(result.finalText, "STEERED:focus on boundary tests");
    assert.equal(result.turnIndex, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("headless is default and live RPC is required for steer", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-headless-"));
  const fake = fakeLauncher(temporary, `
const args = process.argv.slice(2);
await new Promise((resolve) => setTimeout(resolve, 300));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify(args)}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "headless", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "plain task"], env);
    const steer = command(["steer", "--run-id", "headless", "--", "not allowed"], env, true);
    assert.equal(steer.status, 2);
    assert.match(steer.stderr, /--live/);
    const result = command(["wait", "--full", "--run-id", "headless", "--timeout", "10"], env).json.results[0];
    const args = JSON.parse(result.finalText);
    assert.equal(result.live, false);
    assert.equal(result.idleTimeoutSeconds, 0);
    assert.equal(args.includes("rpc"), false);
    assert.equal(args.at(-1), "plain task");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("wait returns immediately when one run fails while peers continue", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-fail-fast-"));
  const fake = fakeLauncher(temporary, `
const prompt = process.argv.at(-1);
if (prompt === "fail now") process.exit(7);
await new Promise((resolve) => setTimeout(resolve, 1200));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "fast-fail", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "fail now"], env);
    command(["dispatch", "--run-id", "slow-success", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "finish later"], env);
    const started = Date.now();
    const failed = command(["wait", "--full", "--run-id", "fast-fail", "--run-id", "slow-success", "--timeout", "10"], env, true);
    assert.equal(failed.status, 3);
    assert.equal(failed.json.state, "failed");
    assert.equal(failed.json.results[0].runId, "fast-fail");
    assert.deepEqual(failed.json.pending, ["slow-success"]);
    assert.ok(Date.now() - started < 1000);
    assert.equal(command(["wait", "--full", "--run-id", "slow-success", "--timeout", "10"], env).json.results[0].state, "success");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("continue reuses the managed session and preserves a compact prior turn", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-session-"));
  const fake = fakeLauncher(temporary, `
import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
mkdirSync(sessionDir, {recursive:true});
const marker = join(sessionDir, "marker");
const continuing = args.includes("--continue");
if (continuing && !existsSync(marker)) process.exit(9);
writeFileSync(marker, "saved");
if (continuing) await new Promise((resolve) => setTimeout(resolve, 300));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:continuing ? "CONTINUED" : "FIRST"}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    const receipt = command(["dispatch", "--run-id", "session", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "first"], env).json;
    const first = command(["wait", "--full", "--run-id", "session", "--timeout", "10"], env).json.results[0];
    assert.equal(first.finalText, "FIRST");
    assert.ok(existsSync(join(receipt.sessionDir, "marker")));
    const lock = join(env.PI_WORKER_STATE_ROOT, "session", ".lifecycle.lock");
    writeFileSync(lock, "busy");
    const busy = command(["continue", "--run-id", "session", "--", "blocked"], env, true);
    assert.equal(busy.status, 3);
    assert.match(busy.stderr, /lifecycle is busy/);
    rmSync(lock);
    writeFileSync(lock, JSON.stringify({pid:99999999}));
    command(["continue", "--run-id", "session", "--", "second"], env);
    const live = JSON.parse(readFileSync(join(env.PI_WORKER_STATE_ROOT, "session", "result.json"), "utf8"));
    assert.equal(live.assistantCalls, 0);
    assert.equal(live.firstToolAt, null);
    const second = command(["wait", "--full", "--run-id", "session", "--timeout", "10"], env).json.results[0];
    assert.equal(second.finalText, "CONTINUED");
    assert.equal(second.turnIndex, 2);
    assert.equal(second.turns[0].finalText, "FIRST");
    assert.equal(second.sessionDir, receipt.sessionDir);
    command(["cleanup", "--reviewed", "yes", "--run-id", "session"], env);
    assert.ok(!existsSync(receipt.sessionDir));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Agy backend maps stream events, usage, tools, and owned CLI arguments", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-agy-stream-"));
  const marker = join(temporary, "agy-args.json");
  const fake = fakeLauncher(temporary, `
import {writeFileSync} from "node:fs";
writeFileSync(process.env.AGY_TEST_ARGS, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({event:"init",conversation_id:"agy-conversation-1",init:{model:"gemini-3.8-flash-high"}}));
console.log(JSON.stringify({event:"step_update",step_update:{step_index:2,state:"RUNNING",step_type:"grep_search",tool_name:"grep_search"}}));
console.log(JSON.stringify({event:"step_update",step_update:{step_index:2,state:"DONE",step_type:"grep_search",tool_name:"grep_search"}}));
console.log(JSON.stringify({event:"step_update",step_update:{state:"DONE",step_type:"agent_response"}}));
console.log(JSON.stringify({event:"result",result:{conversation_id:"agy-conversation-1",status:"SUCCESS",response:"AGY_DONE",num_turns:2,usage:{input_tokens:11,output_tokens:7,thinking_tokens:5,cache_read_tokens:3,total_tokens:23}}}));`);
  const env = testEnv(temporary, "/missing-pi");
  env.AGY_WORKER_LAUNCHER = fake;
  env.AGY_TEST_ARGS = marker;
  try {
    const receipt = command(["dispatch", "--backend", "agy", "--run-id", "agy-stream", "--mode", "read", "--workdir", temporary, "--", "--model", "gemini-3.8-flash-high", "task"], env).json;
    const result = command(["wait", "--full", "--run-id", "agy-stream", "--timeout", "10"], env).json.results[0];
    const args = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(receipt.backend, "agy");
    assert.equal(receipt.sessionDir, null);
    assert.equal(result.state, "success");
    assert.equal(result.backend, "agy");
    assert.equal(result.provider, null);
    assert.equal(result.model, "gemini-3.8-flash-high");
    assert.equal(result.thinking, "high");
    assert.equal(result.finalText, "AGY_DONE");
    assert.equal(result.conversationId, "agy-conversation-1");
    assert.equal(result.backendStatus, "SUCCESS");
    assert.equal(result.backendTurns, 2);
    assert.equal(result.assistantCalls, 1);
    assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 7, thinking_tokens: 5, cache_read_tokens: 3, total_tokens: 23 });
    assert.equal(result.reportedReasoningTokens, 5);
    assert.deepEqual(result.tools, [{ name: "grep_search", count: 1, errorCount: 0 }]);
    assert.equal(typeof result.firstToolAt, "string");
    assert.equal(args[args.indexOf("--mode") + 1], "plan");
    assert.equal(args[args.indexOf("--print-timeout") + 1], "24h");
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
    assert.equal(args.includes("--disable-slash-commands"), false);
    assert.deepEqual(args.slice(-2), ["-p", "task"]);
    assert.equal(result.agentDir, undefined);
    command(["cleanup", "--reviewed", "yes", "--run-id", "agy-stream"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Agy backend preserves partial output but fails an error terminal", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-agy-error-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({event:"init",conversation_id:"agy-error",init:{model:"gemini-3.8-flash-high"}}));
console.log(JSON.stringify({event:"result",result:{conversation_id:"agy-error",status:"ERROR",response:"PARTIAL_FINDING",error:"HTTP 429 too many requests",num_turns:1,usage:{input_tokens:10,output_tokens:2,total_tokens:12}}}));`);
  const env = testEnv(temporary, "/missing-pi");
  env.AGY_WORKER_LAUNCHER = fake;
  try {
    command(["dispatch", "--backend", "agy", "--run-id", "agy-error", "--workdir", temporary, "--", "--model", "gemini-3.8-flash-high", "task"], env);
    const attention = command(["wait", "--full", "--run-id", "agy-error", "--timeout", "10"], env, true);
    assert.ok([3, 4].includes(attention.status));
    const final = command(["wait", "--full", "--run-id", "agy-error", "--timeout", "10"], env, true);
    assert.equal(final.status, 3);
    const result = final.json.results[0];
    assert.equal(result.state, "failed");
    assert.equal(result.reasonCode, "provider_error");
    assert.equal(result.reason, "HTTP 429 too many requests");
    assert.equal(result.finalText, "PARTIAL_FINDING");
    assert.equal(result.attention.category, "rate_limit");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Agy backend rejects a nominal success with denied required actions", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-agy-denied-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({event:"init",conversation_id:"agy-denied",init:{model:"gemini-3.8-flash-high"}}));
console.log(JSON.stringify({event:"result",result:{conversation_id:"agy-denied",status:"SUCCESS",response:"",denied_actions:[{tool_name:"run_command"}],num_turns:1,usage:{input_tokens:10,output_tokens:2,total_tokens:12}}}));`);
  const env = testEnv(temporary, "/missing-pi");
  env.AGY_WORKER_LAUNCHER = fake;
  try {
    command(["dispatch", "--backend", "agy", "--run-id", "agy-denied", "--workdir", temporary, "--", "--model", "gemini-3.8-flash-high", "task"], env);
    const first = command(["wait", "--full", "--run-id", "agy-denied", "--timeout", "10"], env, true);
    assert.ok([3, 4].includes(first.status));
    const waited = first.status === 3 ? first : command(["wait", "--full", "--run-id", "agy-denied", "--timeout", "10"], env, true);
    assert.equal(waited.status, 3);
    const result = waited.json.results[0];
    assert.equal(result.state, "failed");
    assert.equal(result.reasonCode, "provider_error");
    assert.match(result.reason, /denied 1 required action/);
    assert.equal(result.attention.category, "permission_denied");
    assert.equal(result.backendDeniedActionCount, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Agy backend classifies a bare eligibility EOF as transport attention", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-agy-eof-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({event:"result",result:{status:"ERROR",response:"",error:"Eligibility check failed: Get userinfo: EOF",num_turns:0,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}}));`);
  const env = testEnv(temporary, "/missing-pi");
  env.AGY_WORKER_LAUNCHER = fake;
  try {
    command(["dispatch", "--backend", "agy", "--run-id", "agy-eof", "--workdir", temporary, "--", "--model", "gemini-3.8-flash-high", "task"], env);
    const first = command(["wait", "--full", "--run-id", "agy-eof", "--timeout", "10"], env, true);
    assert.ok([3, 4].includes(first.status));
    const waited = first.status === 3 ? first : command(["wait", "--full", "--run-id", "agy-eof", "--timeout", "10"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results[0].attention.category, "transport");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Agy backend classifies an interrupted stream as transport attention", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-agy-interrupted-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({event:"result",result:{status:"ERROR",response:"PARTIAL",error:"The stream was interrupted. Please continue the task you were working on.",num_turns:1,usage:{input_tokens:2,output_tokens:1,total_tokens:3}}}));`);
  const env = testEnv(temporary, "/missing-pi");
  env.AGY_WORKER_LAUNCHER = fake;
  try {
    command(["dispatch", "--backend", "agy", "--run-id", "agy-interrupted", "--workdir", temporary, "--", "--model", "gemini-3.8-flash-high", "task"], env);
    const first = command(["wait", "--full", "--run-id", "agy-interrupted", "--timeout", "10"], env, true);
    const waited = first.status === 3 ? first : command(["wait", "--full", "--run-id", "agy-interrupted", "--timeout", "10"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results[0].attention.category, "transport");
    assert.equal(waited.json.results[0].finalText, "PARTIAL");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Agy backend continues the exact conversation in the same managed worktree", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-agy-continue-"));
  const source = join(temporary, "source");
  mkdirSync(source);
  execFileSync("git", ["-C", source, "init", "-q"]);
  execFileSync("git", ["-C", source, "config", "user.email", "pi-worker@test.invalid"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Pi Worker Test"]);
  writeFileSync(join(source, "base.txt"), "base\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  const fake = fakeLauncher(temporary, `
import {writeFileSync} from "node:fs";
const args = process.argv.slice(2);
const conversation = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : null;
writeFileSync(conversation ? "continued.txt" : "first.txt", conversation ?? "first");
console.log(JSON.stringify({event:"init",conversation_id:conversation ?? "agy-first",init:{model:"gemini-3.8-flash-medium"}}));
console.log(JSON.stringify({event:"result",result:{conversation_id:conversation ? "agy-second" : "agy-first",status:"SUCCESS",response:conversation ? "SECOND" : "FIRST",num_turns:1,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));`);
  const env = testEnv(temporary, "/missing-pi");
  env.AGY_WORKER_LAUNCHER = fake;
  try {
    const receipt = command(["dispatch", "--backend", "agy", "--run-id", "agy-continue", "--mode", "write", "--source", source, "--", "--model", "gemini-3.8-flash-medium", "first"], env).json;
    const first = command(["wait", "--full", "--run-id", "agy-continue", "--timeout", "10"], env).json.results[0];
    assert.equal(first.finalText, "FIRST");
    assert.equal(first.conversationId, "agy-first");
    command(["continue", "--run-id", "agy-continue", "--", "second"], env);
    const second = command(["wait", "--full", "--run-id", "agy-continue", "--timeout", "10"], env).json.results[0];
    assert.equal(second.finalText, "SECOND");
    assert.equal(second.conversationId, "agy-second");
    assert.equal(second.turns[0].conversationId, "agy-first");
    assert.equal(readFileSync(join(receipt.workdir, "continued.txt"), "utf8"), "agy-first");
    const patch = readFileSync(second.patchPath, "utf8");
    assert.match(patch, /first\.txt/);
    assert.match(patch, /continued\.txt/);
    command(["cleanup", "--reviewed", "yes", "--run-id", "agy-continue"], env);
    assert.ok(!existsSync(receipt.workdir));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Agy backend rejects unsupported Pi-only features and effort levels", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-agy-options-"));
  const env = testEnv(temporary, "/missing");
  try {
    const capability = command(["dispatch", "--backend", "agy", "--run-id", "agy-capability", "--workdir", temporary, "--capability", "docs", "--", "--model", "gemini-3.8-flash-high", "task"], env, true);
    assert.equal(capability.status, 2);
    assert.match(capability.stderr, /does not support Pi capabilities/);
    const live = command(["dispatch", "--backend", "agy", "--run-id", "agy-live", "--workdir", temporary, "--live", "--", "--model", "gemini-3.8-flash-high", "task"], env, true);
    assert.equal(live.status, 2);
    assert.match(live.stderr, /does not support --live/);
    const effort = command(["dispatch", "--backend", "agy", "--run-id", "agy-max", "--workdir", temporary, "--", "--model", "gemini-3.8-flash-high", "--effort", "max", "task"], env, true);
    assert.equal(effort.status, 2);
    assert.match(effort.stderr, /effort must be one of/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Claude backend maps stream events, tools, usage, and owned CLI arguments", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-claude-stream-"));
  const marker = join(temporary, "claude-args.json");
  const fake = fakeLauncher(temporary, `
import {writeFileSync} from "node:fs";
writeFileSync(process.env.CLAUDE_TEST_ARGS, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"claude-session-1"}));
console.log(JSON.stringify({type:"assistant",session_id:"claude-session-1",message:{model:"deepseek/deepseek-v4-flash",stop_reason:"tool_use",content:[{type:"tool_use",id:"tool-1",name:"Read",input:{file_path:"README.md"}}],usage:{input_tokens:10,output_tokens:3}}}));
console.log(JSON.stringify({type:"user",session_id:"claude-session-1",message:{content:[{type:"tool_result",tool_use_id:"tool-1",content:"ok"}]}}));
console.log(JSON.stringify({type:"assistant",session_id:"claude-session-1",message:{model:"deepseek/deepseek-v4-flash",stop_reason:"end_turn",content:[{type:"text",text:"CLAUDE_DONE"}],usage:{input_tokens:12,output_tokens:4}}}));
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"claude-session-1",result:"CLAUDE_DONE",num_turns:2,duration_ms:1200,duration_api_ms:900,total_cost_usd:0.01,usage:{input_tokens:22,output_tokens:7,cache_read_input_tokens:5,output_tokens_details:{thinking_tokens:2}}}));`);
  const env = testEnv(temporary, "/missing-pi");
  env.CLAUDE_WORKER_LAUNCHER = fake;
  env.CLAUDE_TEST_ARGS = marker;
  try {
    const receipt = command(["dispatch", "--backend", "claude", "--run-id", "claude-stream", "--mode", "read", "--workdir", temporary, "--", "--provider", "commandcode", "--model", "deepseek/deepseek-v4-flash", "--allow-orchestration", "task"], env).json;
    const result = command(["wait", "--full", "--run-id", "claude-stream", "--timeout", "10"], env).json.results[0];
    const args = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(receipt.backend, "claude");
    assert.equal(receipt.sessionDir, null);
    assert.equal(result.state, "success");
    assert.equal(result.backend, "claude");
    assert.equal(result.provider, "commandcode");
    assert.equal(result.model, "deepseek/deepseek-v4-flash");
    assert.equal(result.observedProvider, "claude");
    assert.equal(result.observedModel, "deepseek/deepseek-v4-flash");
    assert.equal(result.thinking, "max");
    assert.equal(result.finalText, "CLAUDE_DONE");
    assert.equal(result.conversationId, "claude-session-1");
    assert.equal(result.backendStatus, "SUCCESS");
    assert.equal(result.backendTurns, 2);
    assert.equal(result.assistantCalls, 2);
    assert.equal(result.usage.cache_read_input_tokens, 5);
    assert.equal(result.usage.total_cost_usd, 0.01);
    assert.equal(result.usage.duration_ms, 1200);
    assert.deepEqual(result.tools, [{ name: "Read", count: 1, errorCount: 0 }]);
    assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
    assert.equal(args.includes("--disallowedTools"), false);
    assert.equal(args[args.indexOf("--effort") + 1], "max");
    assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
    assert.equal(args.includes("--provider"), false);
    assert.equal(args.includes("--bare"), false);
    assert.equal(args.includes("--safe-mode"), false);
    assert.deepEqual(args.slice(-2), ["-p", "task"]);
    command(["cleanup", "--reviewed", "yes", "--run-id", "claude-stream"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Claude backend preserves partial output and classifies an error terminal", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-claude-error-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"claude-error"}));
console.log(JSON.stringify({type:"assistant",session_id:"claude-error",message:{model:"deepseek/deepseek-v4-flash",content:[{type:"text",text:"PARTIAL"}]}}));
console.log(JSON.stringify({type:"result",subtype:"error_during_execution",is_error:true,session_id:"claude-error",result:"PARTIAL",errors:["HTTP 503 service unavailable"],num_turns:1,usage:{input_tokens:2,output_tokens:1}}));`);
  const env = testEnv(temporary, "/missing-pi");
  env.CLAUDE_WORKER_LAUNCHER = fake;
  try {
    command(["dispatch", "--backend", "claude", "--run-id", "claude-error", "--workdir", temporary, "--", "--provider", "commandcode", "task"], env);
    const first = command(["wait", "--full", "--run-id", "claude-error", "--timeout", "10"], env, true);
    const waited = first.status === 3 ? first : command(["wait", "--full", "--run-id", "claude-error", "--timeout", "10"], env, true);
    assert.equal(waited.status, 3);
    const result = waited.json.results[0];
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "HTTP 503 service unavailable");
    assert.equal(result.finalText, "PARTIAL");
    assert.equal(result.attention.category, "provider_5xx");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Claude permission denial wakes wait immediately", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-claude-permission-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"claude-permission"}));
console.log(JSON.stringify({type:"system",subtype:"permission_denied",session_id:"claude-permission",tool_name:"Bash"}));
await new Promise((resolve) => setTimeout(resolve, 500));
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"claude-permission",result:"RECOVERED",num_turns:1,usage:{input_tokens:1,output_tokens:1}}));`);
  const env = testEnv(temporary, "/missing-pi");
  env.CLAUDE_WORKER_LAUNCHER = fake;
  try {
    command(["dispatch", "--backend", "claude", "--run-id", "claude-permission", "--workdir", temporary, "--", "task"], env);
    const alert = command(["wait", "--full", "--run-id", "claude-permission", "--timeout", "10"], env, true);
    assert.equal(alert.status, 4);
    assert.equal(alert.json.alerts[0].category, "permission_denied");
    assert.match(alert.json.alerts[0].detail, /Bash/);
    const final = command(["wait", "--full", "--run-id", "claude-permission", "--timeout", "10"], env);
    assert.equal(final.json.results[0].state, "success");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Claude backend continues the exact session in the same managed worktree", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-claude-continue-"));
  const source = join(temporary, "source");
  mkdirSync(source);
  execFileSync("git", ["-C", source, "init", "-q"]);
  execFileSync("git", ["-C", source, "config", "user.email", "pi-worker@test.invalid"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Pi Worker Test"]);
  writeFileSync(join(source, "base.txt"), "base\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  const fake = fakeLauncher(temporary, `
import {writeFileSync} from "node:fs";
const args=process.argv.slice(2);
const resumed=args.includes("--resume") ? args[args.indexOf("--resume")+1] : null;
writeFileSync(resumed ? "continued-args.json" : "first-args.json", JSON.stringify(args));
writeFileSync(resumed ? "continued.txt" : "first.txt", resumed ?? "first");
console.log(JSON.stringify({type:"system",subtype:"init",session_id:resumed ? "claude-second" : "claude-first"}));
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:resumed ? "claude-second" : "claude-first",result:resumed ? "SECOND" : "FIRST",num_turns:1,usage:{input_tokens:1,output_tokens:1}}));`);
  const env = testEnv(temporary, "/missing-pi");
  env.CLAUDE_WORKER_LAUNCHER = fake;
  try {
    const receipt = command(["dispatch", "--backend", "claude", "--run-id", "claude-continue", "--mode", "write", "--source", source, "--", "--provider", "commandcode", "first"], env).json;
    const first = command(["wait", "--full", "--run-id", "claude-continue", "--timeout", "10"], env).json.results[0];
    assert.equal(first.conversationId, "claude-first");
    const firstArgs = JSON.parse(readFileSync(join(receipt.workdir, "first-args.json"), "utf8"));
    assert.equal(firstArgs[firstArgs.indexOf("--permission-mode") + 1], "auto");
    assert.match(firstArgs[firstArgs.indexOf("--disallowedTools") + 1], /Agent/);
    command(["continue", "--run-id", "claude-continue", "--", "second"], env);
    const second = command(["wait", "--full", "--run-id", "claude-continue", "--timeout", "10"], env).json.results[0];
    assert.equal(second.finalText, "SECOND");
    assert.equal(second.conversationId, "claude-second");
    assert.equal(second.turns[0].conversationId, "claude-first");
    assert.equal(readFileSync(join(receipt.workdir, "continued.txt"), "utf8"), "claude-first");
    command(["cleanup", "--reviewed", "yes", "--run-id", "claude-continue"], env);
    assert.ok(!existsSync(receipt.workdir));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Claude backend rejects unsupported Pi-only features and invalid options", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-claude-options-"));
  const env = testEnv(temporary, "/missing");
  try {
    const capability = command(["dispatch", "--backend", "claude", "--run-id", "claude-capability", "--workdir", temporary, "--capability", "docs", "--", "task"], env, true);
    assert.equal(capability.status, 2);
    assert.match(capability.stderr, /does not support Pi capabilities/);
    const live = command(["dispatch", "--backend", "claude", "--run-id", "claude-live", "--workdir", temporary, "--live", "--", "task"], env, true);
    assert.equal(live.status, 2);
    assert.match(live.stderr, /does not support --live/);
    const provider = command(["dispatch", "--backend", "claude", "--run-id", "claude-provider", "--workdir", temporary, "--", "--provider", "unknown", "task"], env, true);
    assert.equal(provider.status, 2);
    assert.match(provider.stderr, /provider must be commandcode or native/);
    const effort = command(["dispatch", "--backend", "claude", "--run-id", "claude-effort", "--workdir", temporary, "--", "--effort", "minimal", "task"], env, true);
    assert.equal(effort.status, 2);
    assert.match(effort.stderr, /effort must be one of/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("continuation preserves the prior failure diagnosis", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-session-failure-"));
  const fake = fakeLauncher(temporary, `
const continuing = process.argv.includes("--continue");
if (!continuing) {
  process.stderr.write("HTTP 503 service unavailable\\n");
  process.exit(7);
}
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "failed-session", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "first"], env);
    const alert = command(["wait", "--full", "--run-id", "failed-session", "--timeout", "10"], env, true);
    assert.equal(alert.status, 4);
    const first = command(["wait", "--full", "--run-id", "failed-session", "--timeout", "10"], env, true).json.results[0];
    assert.equal(first.reasonCode, "missing_settled");
    assert.equal(first.attention.category, "provider_5xx");
    command(["continue", "--run-id", "failed-session", "--", "retry"], env);
    const second = command(["wait", "--full", "--run-id", "failed-session", "--timeout", "10"], env).json.results[0];
    assert.equal(second.turns[0].reasonCode, "missing_settled");
    assert.equal(second.turns[0].reason, "missing agent_settled");
    assert.equal(second.turns[0].attention.category, "provider_5xx");
    assert.equal(second.turns[0].assistantCalls, 0);
    assert.equal(typeof second.turns[0].elapsedSeconds, "number");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("status exposes bounded live activity without persisting process observations", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-activity-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"a",toolName:"read",args:{secret:"must-not-persist"}}));
console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"b",toolName:"bash",args:{command:"private"}}));
await new Promise((resolve) => setTimeout(resolve, 800));
console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"a",toolName:"read",isError:false}));
console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"b",toolName:"bash",isError:false}));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "activity", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    let observed;
    for (let index = 0; index < 40; index += 1) {
      observed = command(["status", "--run-id", "activity"], env).json.runs[0].result;
      if (observed.activeTools?.length === 2) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    assert.equal(observed.state, "running");
    assert.equal(observed.activity, "running_tools");
    assert.deepEqual(observed.activeTools.map((tool) => tool.name).sort(), ["bash", "read"]);
    assert.ok(observed.supervisorAlive);
    assert.ok(observed.childAlive);
    assert.ok(observed.firstToolAt);
    assert.ok(observed.lastToolAt);
    assert.equal(observed.lastEventType, "tool_execution_start");
    assert.equal(typeof observed.activitySeconds, "number");
    assert.doesNotMatch(JSON.stringify(observed.activeTools), /secret|private/);
    const stored = JSON.parse(readFileSync(join(env.PI_WORKER_STATE_ROOT, "activity", "result.json"), "utf8"));
    assert.equal(stored.supervisorAlive, undefined);
    assert.equal(stored.childAlive, undefined);
    const result = command(["wait", "--full", "--run-id", "activity", "--timeout", "10"], env).json.results[0];
    assert.equal(result.state, "success");
    assert.equal(result.activity, null);
    assert.deepEqual(result.activeTools, []);
    assert.ok(result.firstEventAt);
    assert.ok(result.lastEventAt);
    assert.ok(result.firstToolAt);
    assert.ok(result.lastToolAt);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("cancel stops the child through the supervisor and produces a reviewable terminal result", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-cancel-"));
  const fake = fakeLauncher(temporary, `
process.on("SIGTERM", () => process.exit(0));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"toolUse",content:[{type:"text",text:"WORKING"}]}}));
await new Promise((resolve) => setTimeout(resolve, 5000));`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "cancelled", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    const response = command(["cancel", "--run-id", "cancelled", "--reason", "scope withdrawn", "--timeout", "10"], env).json;
    assert.equal(response.state, "cancelled");
    const cancelled = response.results[0];
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.reasonCode, "user_cancelled");
    assert.equal(cancelled.reason, "scope withdrawn");
    assert.equal(cancelled.activity, null);
    assert.equal(cancelled.cleanupRequired, true);
    assert.ok(existsSync(cancelled.failureLogPath));
    const waited = command(["wait", "--full", "--run-id", "cancelled", "--timeout", "1"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results[0].state, "cancelled");
    assert.equal(command(["cancel", "--run-id", "cancelled", "--timeout", "1"], env).json.state, "cancelled");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("successful completion terminates worker-owned background processes", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-process-cleanup-"));
  const marker = join(temporary, "background.pid");
  const fake = fakeLauncher(temporary, `
import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
const background = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore"});
background.unref();
writeFileSync(process.env.PI_WORKER_TEST_BACKGROUND_PID, String(background.pid));
${successEvents}`);
  const env = testEnv(temporary, fake);
  env.PI_WORKER_TEST_BACKGROUND_PID = marker;
  let backgroundPid;
  let supervisorPid;
  try {
    supervisorPid = command(["dispatch", "--run-id", "process-cleanup", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env).json.supervisorPid;
    const result = command(["wait", "--full", "--run-id", "process-cleanup", "--timeout", "10"], env).json.results[0];
    assert.equal(result.state, "success");
    backgroundPid = Number(readFileSync(marker, "utf8"));
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      try {
        process.kill(backgroundPid, 0);
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      } catch {
        backgroundPid = null;
        break;
      }
    }
    assert.equal(backgroundPid, null, "worker-owned background process remained alive after success");
    command(["cleanup", "--reviewed", "yes", "--run-id", "process-cleanup"], env);
  } finally {
    if (!backgroundPid && existsSync(marker)) backgroundPid = Number(readFileSync(marker, "utf8"));
    if (backgroundPid) try { process.kill(backgroundPid, "SIGKILL"); } catch {}
    if (supervisorPid) try { process.kill(supervisorPid, "SIGTERM"); } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("status converts every vanished supervisor into a durable failed result", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-orphan-"));
  const env = testEnv(temporary, process.execPath);
  for (const id of ["orphan-a", "orphan-b"]) {
    const directory = join(env.PI_WORKER_STATE_ROOT, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "result.json"), JSON.stringify({schema:2,runId:id,state:"running",mode:"read",supervisorPid:99999999,childPid:null,managedWorktree:false,workdir:temporary,startedAt:new Date().toISOString()}));
  }
  try {
    const status = command(["status", "--run-id", "orphan-a", "--run-id", "orphan-b"], env).json;
    assert.deepEqual(status.runs.map((item) => item.result.state), ["failed", "failed"]);
    assert.ok(status.runs.every((item) => item.result.reasonCode === "supervisor_lost"));
    assert.ok(status.runs.every((item) => item.result.schema === 3));
    assert.ok(status.runs.every((item) => existsSync(item.result.failureLogPath)));
    const waited = command(["wait", "--full", "--run-id", "orphan-a", "--run-id", "orphan-b", "--timeout", "1"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results.length, 2);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("optional idle timeout stops a silent worker", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-idle-"));
  const fake = fakeLauncher(temporary, "await new Promise((resolve) => setTimeout(resolve, 5000));");
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "idle", "--workdir", temporary, "--idle-timeout", "0.2", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    const waited = command(["wait", "--full", "--run-id", "idle", "--timeout", "10"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results[0].reason, "idle timeout");
    assert.equal(waited.json.results[0].timeoutType, "idle");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("runtime expands named capabilities and owns their tool allowlists", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-capability-"));
  const agent = join(temporary, "agent");
  const extension = join(agent, "npm", "node_modules", "@upstash", "context7-pi", "extensions", "context7.ts");
  const skill = join(agent, "npm", "node_modules", "@upstash", "context7-pi", "skills", "context7-docs", "SKILL.md");
  mkdirSync(resolve(extension, ".."), { recursive: true });
  mkdirSync(resolve(skill, ".."), { recursive: true });
  writeFileSync(extension, "export default function noop() {}\n");
  writeFileSync(skill, "---\nname: context7-docs\ndescription: docs\n---\n");
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify(process.argv.slice(2))}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = { ...testEnv(temporary, fake), PI_CODING_AGENT_DIR: agent };
  try {
    command(["dispatch", "--run-id", "docs", "--workdir", temporary, "--capability", "docs", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    const result = command(["wait", "--full", "--run-id", "docs", "--timeout", "10"], env).json.results[0];
    const args = JSON.parse(result.finalText);
    const tools = args.indexOf("--tools");
    assert.equal(args[tools + 1], "read,bash,grep,ls,web_search,resolve-library-id,query-docs");
    assert.ok(args.includes("This is a read-only task. Do not modify repository files. Use bash only for inspection or commands known not to write project files."));
    const sessionDir = args.indexOf("--session-dir");
    assert.equal(args[sessionDir + 1], result.sessionDir);
    assert.ok(args.includes(extension));
    assert.ok(args.includes(skill));
    assert.deepEqual(result.capabilities, ["docs"]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("optional package skills load only with their matching capability", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-optional-skills-"));
  const agent = join(temporary, "agent");
  const npm = join(agent, "npm", "node_modules");
  const resources = {
    lens: [join(npm, "pi-lens", "dist", "index.js"), join(npm, "pi-lens", "skills")],
    context: [join(npm, "context-mode", "build", "adapters", "pi", "extension.js"), join(npm, "context-mode", "skills")],
    browser: [join(npm, "pi-playwright", "skills", "playwright-browser", "SKILL.md")],
  };
  for (const paths of Object.values(resources)) for (const path of paths) {
    if (path.endsWith("skills")) mkdirSync(path, { recursive: true });
    else {
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, path.endsWith(".md") ? "---\nname: test\ndescription: test\n---\n" : "export default function noop() {}\n");
    }
  }
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify(process.argv.slice(2))}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = { ...testEnv(temporary, fake), PI_CODING_AGENT_DIR: agent };
  try {
    for (const [capability, paths] of Object.entries(resources)) {
      command(["dispatch", "--run-id", capability, "--workdir", temporary, "--capability", capability, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
      const result = command(["wait", "--full", "--run-id", capability, "--timeout", "10"], env).json.results[0];
      const args = JSON.parse(result.finalText);
      assert.ok(paths.every((path) => args.includes(path)));
      assert.deepEqual(result.capabilities, [capability]);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("write mode carries dirty source state, captures only worker changes, and waits for review cleanup", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-write-"));
  const source = join(temporary, "source");
  mkdirSync(source);
  execFileSync("git", ["-C", source, "init", "-q"]);
  execFileSync("git", ["-C", source, "config", "user.email", "pi-worker@test.invalid"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Pi Worker Test"]);
  writeFileSync(join(source, "existing.txt"), "committed\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  writeFileSync(join(source, "existing.txt"), "user dirty\n");
  writeFileSync(join(source, "staged.txt"), "user staged\n");
  execFileSync("git", ["-C", source, "add", "staged.txt"]);
  mkdirSync(join(source, "nested"));
  writeFileSync(join(source, "nested", "untracked.txt"), "user untracked\n");
  mkdirSync(join(source, "tests", "__pycache__"), { recursive: true });
  writeFileSync(join(source, "tests", "__pycache__", "baseline.pyc"), "baseline cache");
  mkdirSync(join(source, "src", "nested.egg-info"), { recursive: true });
  writeFileSync(join(source, "src", "nested.egg-info", "BASE"), "baseline cache");
  const fake = fakeLauncher(temporary, `
import {mkdirSync,writeFileSync} from "node:fs";
writeFileSync("worker.txt", "worker change\\n");
mkdirSync("__pycache__");
writeFileSync("__pycache__/module.pyc", "cache");
mkdirSync("tests/__pycache__", {recursive:true});
writeFileSync("tests/__pycache__/test_module.pyc", "cache");
mkdirSync("pkg.egg-info");
writeFileSync("pkg.egg-info/PKG-INFO", "cache");
mkdirSync("src/nested.egg-info", {recursive:true});
writeFileSync("src/nested.egg-info/PKG-INFO", "cache");
mkdirSync(".pytest_cache");
writeFileSync(".pytest_cache/state", "cache");
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify(process.argv.slice(2))}],usage:{input:1,output:1}}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    const receipt = command(["dispatch", "--run-id", "write", "--mode", "write", "--source", source, "--", "--provider", "commandcode", "--model", "google/gemini-3.7-flash", "--thinking", "high"], env).json;
    const settled = command(["wait", "--full", "--run-id", "write", "--timeout", "10"], env).json.results[0];
    assert.equal(settled.state, "success");
    assert.equal(settled.thinking, "high");
    assert.equal(readFileSync(join(receipt.workdir, "existing.txt"), "utf8"), "user dirty\n");
    assert.equal(readFileSync(join(receipt.workdir, "staged.txt"), "utf8"), "user staged\n");
    assert.equal(readFileSync(join(receipt.workdir, "nested", "untracked.txt"), "utf8"), "user untracked\n");
    const initial = JSON.parse(readFileSync(join(env.PI_WORKER_STATE_ROOT, "write", "result.json"), "utf8"));
    assert.equal(initial.mode, "write");
    const args = JSON.parse(settled.finalText);
    const tools = args.indexOf("--tools");
    assert.equal(args[tools + 1], "read,bash,edit,write,grep,ls,web_search");
    assert.ok(existsSync(receipt.workdir), "worktree must remain until Codex review");
    assert.ok(!existsSync(join(source, "worker.txt")));
    const patch = readFileSync(settled.patchPath, "utf8");
    assert.match(patch, /worker\.txt/);
    assert.doesNotMatch(patch, /__pycache__|egg-info|pytest_cache/);
    assert.ok(!existsSync(join(receipt.workdir, "__pycache__")));
    assert.ok(existsSync(join(receipt.workdir, "tests", "__pycache__", "baseline.pyc")));
    assert.ok(!existsSync(join(receipt.workdir, "tests", "__pycache__", "test_module.pyc")));
    assert.ok(!existsSync(join(receipt.workdir, "pkg.egg-info")));
    assert.ok(existsSync(join(receipt.workdir, "src", "nested.egg-info", "BASE")));
    assert.ok(!existsSync(join(receipt.workdir, "src", "nested.egg-info", "PKG-INFO")));
    assert.ok(!existsSync(join(receipt.workdir, ".pytest_cache")));
    assert.doesNotMatch(patch, /existing\.txt/);
    assert.doesNotMatch(patch, /staged\.txt|untracked\.txt/);
    const premature = command(["cleanup", "--run-id", "write"], env, true);
    assert.equal(premature.status, 2);
    assert.ok(existsSync(receipt.workdir));
    const cleaned = command(["cleanup", "--reviewed", "yes", "--run-id", "write"], env).json;
    assert.equal(cleaned.cleaned[0].worktreeRemoved, true);
    assert.ok(!existsSync(receipt.workdir));
    assert.doesNotMatch(execFileSync("git", ["-C", source, "worktree", "list", "--porcelain"], { encoding: "utf8" }), new RegExp(receipt.workdir));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the public wrapper executes its adjacent staged runtime", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-wrapper-"));
  try {
    const result = spawnSync(join(root, "bin", "pi-worker"), ["cache-status"], {
      encoding: "utf8",
      env: { ...process.env, PI_WORKER_TEST_CACHE_ROOTS: temporary, PI_WORKER_CACHE_MAX_BYTES: "1234" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).maxBytes, 1234);
    const help = spawnSync(join(root, "bin", "pi-worker"), ["--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--capability/);
    const profiles = spawnSync(join(root, "bin", "pi-worker"), ["profiles"], { encoding: "utf8" });
    const profileOutput = JSON.parse(profiles.stdout);
    const configured = profileOutput.models;
    assert.deepEqual(profileOutput.backends.agy, { efforts: ["low", "medium", "high"], defaultEffort: "high", live: false });
    assert.deepEqual(profileOutput.backends.claude, { efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "max", live: false });
    assert.ok(configured.some((profile) => profile.id === "deepseek/deepseek-v4-flash"));
    assert.ok(configured.some((profile) => profile.id === "ahzm/glm-5.3" && profile.defaultThinking === "max"));
    assert.ok(configured.some((profile) => profile.id === "commandcode/Qwen/Qwen3.8-Flash" && profile.defaultThinking === "max"));
    assert.ok(!configured.some((profile) => profile.id.startsWith("opencode-go/")));
    const cancel = spawnSync(join(root, "bin", "pi-worker"), ["cancel", "--run-id", "missing"], {
      encoding: "utf8",
      env: { ...process.env, PI_WORKER_STATE_ROOT: temporary },
    });
    assert.equal(cancel.status, 2);
    assert.match(cancel.stderr, /unknown run/);
    assert.doesNotMatch(cancel.stderr, /startup session lookup/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the public wrapper falls back to PATH when the preferred Node path is absent", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-wrapper-path-"));
  const home = join(temporary, "empty-home");
  mkdirSync(home, { recursive: true });
  try {
    const result = spawnSync(join(root, "bin", "pi-worker"), ["cache-status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
        PI_WORKER_TEST_CACHE_ROOTS: temporary,
        PI_WORKER_CACHE_MAX_BYTES: "4321",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).maxBytes, 4321);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the headless wrapper keeps optional extensions out of the default path", () => {
  const wrapper = readFileSync(join(root, "bin", "pi-worker"), "utf8");
  assert.match(wrapper, /--no-extensions/);
  assert.match(wrapper, /--offline/);
  assert.doesNotMatch(wrapper, /--no-skills/);
  assert.doesNotMatch(wrapper, /--no-session/);
  assert.match(wrapper, /previous.*--mode/s);
  assert.match(wrapper, /--no-prompt-templates/);
  assert.match(wrapper, /write only inside the current working directory or TMPDIR/);
  assert.match(wrapper, /Do not scan the whole repository unless the task explicitly requires it or targeted evidence is insufficient/);
  assert.match(wrapper, /For output-only or connectivity checks, do not call tools/);
  assert.doesNotMatch(wrapper, /@upstash\/context7-pi/);
  assert.doesNotMatch(wrapper, /resolve-library-id|query-docs/);
  assert.doesNotMatch(wrapper, /node_modules\/pi-lens/);
  assert.doesNotMatch(wrapper, /node_modules\/pi-mcp-adapter/);
  assert.doesNotMatch(wrapper, /node_modules\/context-mode/);
});

test("the public wrapper fails before dispatch when Codex blocks provider network", () => {
  const blocked = spawnSync(join(root, "bin", "pi-worker"), ["dispatch"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1" },
  });
  assert.equal(blocked.status, 69);
  assert.match(blocked.stderr, /provider network is blocked by the Codex sandbox/);
  assert.match(blocked.stderr, /sandbox_permissions="require_escalated"/);
});

test("Playwright runs get a unique session and supervisor-owned close", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-playwright-"));
  const agent = join(temporary, "agent");
  const marker = join(temporary, "closed.json");
  const closeScript = join(agent, "npm", "node_modules", "pi-playwright", "skills", "playwright-browser", "scripts", "pw.js");
  mkdirSync(resolve(closeScript, ".."), { recursive: true });
  writeFileSync(closeScript, `import {writeFileSync} from "node:fs"; writeFileSync(process.env.PI_WORKER_TEST_PLAYWRIGHT_MARKER, JSON.stringify({args:process.argv.slice(2),session:process.env.PLAYWRIGHT_CLI_SESSION,artifacts:process.env.PI_PLAYWRIGHT_ARTIFACTS}));`);
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"tool_execution_start",toolName:"bash",args:{command:"node /tmp/pi-playwright/skills/playwright-browser/scripts/pw.js open"}}));
${successEvents}`);
  const env = { ...testEnv(temporary, fake), PI_WORKER_AGENT_SOURCE: agent, PI_WORKER_TEST_PLAYWRIGHT_MARKER: marker };
  try {
    command(["dispatch", "--run-id", "browser", "--workdir", temporary, "--", "--provider", "xai", "--model", "grok-4.5"], env);
    const result = command(["wait", "--full", "--run-id", "browser", "--timeout", "10"], env).json.results[0];
    const closed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(result.state, "success");
    assert.deepEqual(closed.args, ["close"]);
    assert.equal(closed.session, "pi-worker-browser");
    assert.equal(closed.artifacts, join(env.PI_WORKER_STATE_ROOT, "browser", "browser-artifacts"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("production shared-cache discovery parses host paths", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-cache-paths-"));
  const bin = join(temporary, "bin");
  mkdirSync(bin);
  const du = join(bin, "du");
  writeFileSync(du, "#!/bin/sh\nprintf '0 %s\\n' \"$2\"\n");
  chmodSync(du, 0o700);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  delete env.PI_WORKER_TEST_CACHE_ROOTS;
  delete env.PI_WORKER_CACHE_MAX_BYTES;
  try {
    const result = command(["cache-status"], env);
    assert.equal(result.json.maxBytes, 20 * 1024 * 1024 * 1024);
    assert.ok(result.json.entries.length > 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("workers receive the same shared dependency cache paths", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-cache-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify({npm:process.env.npm_config_cache,uv:process.env.UV_CACHE_DIR,pnpmConfig:process.env.npm_config_store_dir??null})}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    for (const id of ["cache-a", "cache-b"]) command(["dispatch", "--run-id", id, "--workdir", temporary, "--", "--provider", "commandcode", "--model", "google/gemini-3.7-flash"], env);
    const results = waitAll(["cache-a", "cache-b"], env);
    assert.equal(results[0].finalText, results[1].finalText);
    const paths = JSON.parse(results[0].finalText);
    assert.equal(paths.npm, join(temporary, ".npm"));
    assert.equal(paths.uv, join(temporary, ".cache", "uv"));
    assert.equal(paths.pnpmConfig, null);
    const status = command(["cache-status"], env).json;
    assert.equal(status.maxBytes, 1024 * 1024);
    assert.equal(status.entries.length, 2);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("cache GC removes stale files without whole-cache purge", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-cache-gc-"));
  const fake = fakeLauncher(temporary, successEvents);
  const env = testEnv(temporary, fake);
  const old = join(temporary, ".npm", "old.bin");
  const recent = join(temporary, ".npm", "recent.bin");
  writeFileSync(old, Buffer.alloc(2 * 1024 * 1024));
  writeFileSync(recent, Buffer.alloc(1024));
  const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  utimesSync(old, oldTime, oldTime);
  try {
    command(["dispatch", "--run-id", "gc", "--workdir", temporary, "--", "--provider", "commandcode", "--model", "google/gemini-3.7-flash"], env);
    command(["wait", "--full", "--run-id", "gc", "--timeout", "10"], env);
    const cache = command(["cleanup", "--reviewed", "yes", "--run-id", "gc"], env).json.cache;
    assert.equal(cache.actionSummary.failed, 0);
    assert.ok(cache.actions.some((action) => action.command === "cache file remove" && action.path === old && action.stale));
    assert.ok(cache.actions.every((action) => !/cache (?:clean --force|purge)|uv cache clean/.test(action.command)));
    assert.ok(!existsSync(old));
    assert.ok(existsSync(recent));
    command(["dispatch", "--run-id", "gc-again", "--workdir", temporary, "--", "--provider", "commandcode", "--model", "google/gemini-3.7-flash"], env);
    command(["wait", "--full", "--run-id", "gc-again", "--timeout", "10"], env);
    const repeated = command(["cleanup", "--reviewed", "yes", "--run-id", "gc-again"], env).json.cache;
    assert.equal(repeated.skipped, "checked within the last day");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("cache GC counts and prunes the oldest rebuildable Pi Lens data", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-lens-cache-gc-"));
  const lens = join(temporary, ".pi-lens");
  mkdirSync(join(lens, "projects"), { recursive: true });
  mkdirSync(join(lens, "tools"), { recursive: true });
  writeFileSync(join(lens, "projects", "index.bin"), Buffer.alloc(1024));
  writeFileSync(join(lens, "tools", "managed.bin"), Buffer.alloc(2 * 1024 * 1024));
  const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  utimesSync(join(lens, "tools", "managed.bin"), oldTime, oldTime);
  const fake = fakeLauncher(temporary, successEvents);
  const env = {
    ...testEnv(temporary, fake),
    PI_WORKER_TEST_CACHE_ROOTS: lens,
    PI_WORKER_CACHE_MAX_BYTES: String(1024 * 1024),
  };
  try {
    command(["dispatch", "--run-id", "lens-gc", "--workdir", temporary, "--", "--provider", "commandcode", "--model", "google/gemini-3.7-flash"], env);
    command(["wait", "--full", "--run-id", "lens-gc", "--timeout", "10"], env);
    const cache = command(["cleanup", "--reviewed", "yes", "--run-id", "lens-gc"], env).json.cache;
    assert.equal(cache.before.entries[0].path, lens);
    assert.equal(cache.actionSummary.failed, 0);
    assert.ok(cache.actions.some((action) => action.command === "cache file remove" && action.path.endsWith("managed.bin")));
    assert.ok(cache.after.totalBytes <= cache.after.maxBytes);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("old result-bearing runs remain until reviewed cleanup", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-review-ttl-"));
  const fake = fakeLauncher(temporary, successEvents);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "old", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    command(["wait", "--full", "--run-id", "old", "--timeout", "10"], env);
    const oldDirectory = join(env.PI_WORKER_STATE_ROOT, "old");
    const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(oldDirectory, oldTime, oldTime);
    command(["dispatch", "--run-id", "new", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    assert.ok(existsSync(oldDirectory));
    command(["wait", "--full", "--run-id", "new", "--timeout", "10"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
