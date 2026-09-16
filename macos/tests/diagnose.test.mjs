import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const events = join(root, "lib/events.mjs");
const launcher = join(root, "bin/subworker");

function cleanSubprocessEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SUBWORKER_") || key.startsWith("PI_WORKER_")) {
      delete env[key];
    }
  }
  delete env.CODEX_THREAD_ID;
  delete env.PI_CODING_AGENT_DIR;
  return Object.assign(env, overrides);
}

function command(args, env, allowFailure = false) {
  const result = spawnSync(process.execPath, [events, ...args], { encoding: "utf8", env });
  if (!allowFailure && (result.status !== 0 || result.signal)) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `command failed: status=${result.status} signal=${result.signal}`;
    const error = new Error(detail);
    error.status = result.status;
    error.signal = result.signal;
    throw error;
  }
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

function testEnv(temporary) {
  const caches = [join(temporary, ".npm"), join(temporary, ".cache", "uv")];
  caches.forEach((path) => mkdirSync(path, { recursive: true }));
  const agent = join(temporary, "agent-source");
  mkdirSync(join(agent, "npm"), { recursive: true });
  for (const name of ["auth.json", "models.json", "models-store.json", "settings.json"]) {
    writeFileSync(join(agent, name), "{}\n");
  }
  return cleanSubprocessEnv({
    PI_WORKER_STATE_ROOT: join(temporary, "state"),
    SUBWORKER_STATE_ROOT: join(temporary, "state"),
    PI_WORKER_AGENT_SOURCE: agent,
    SUBWORKER_AGENT_SOURCE: agent,
    SUBWORKER_NODE_BIN: process.execPath,
    PI_WORKER_TEST_CACHE_ROOTS: caches.join(delimiter),
    PI_WORKER_CACHE_MAX_BYTES: String(1024 * 1024),
  });
}

function createRunFixture(env, runId, payload) {
  const stateRoot = env.SUBWORKER_STATE_ROOT ?? env.PI_WORKER_STATE_ROOT;
  const dir = join(stateRoot, runId);
  mkdirSync(dir, { recursive: true });
  const content = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) + "\n";
  writeFileSync(join(dir, "result.json"), content);
  return dir;
}

test("diagnose reports running task with process liveness, config facts and truthful recommendations", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-diagnose-running-"));
  const env = testEnv(temporary);
  try {
    const workdir = join(temporary, "sample-workdir");
    mkdirSync(workdir, { recursive: true });

    createRunFixture(env, "run-running", {
      schema: 3,
      runId: "run-running",
      backend: "pi",
      state: "running",
      activity: "thinking",
      mode: "write",
      worker: { version: "0.3.0", brand: "subworker" },
      backendVersion: null,
      supervisorPid: process.pid,
      childPid: process.pid,
      workdir,
      managedWorktree: true,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinking: "max",
      observedProvider: "deepseek",
      observedModel: "deepseek-v4-flash",
      observedThinking: "max",
      firstEventAt: new Date(Date.now() - 5000).toISOString(),
      lastEventAt: new Date(Date.now() - 1000).toISOString(),
      lastEventType: "thinking",
    });

    const output = command(["diagnose", "--run-id", "run-running"], env).json;
    assert.ok(Array.isArray(output.runs));
    assert.equal(output.runs.length, 1);

    const run = output.runs[0];
    assert.equal(run.runId, "run-running");
    assert.equal(run.exists, true);
    assert.equal(run.state, "running");
    assert.equal(run.activity, "thinking");
    assert.equal(run.backend, "pi");
    assert.equal(run.workerVersion, "0.3.0");
    assert.equal(run.backendVersion, "unknown");
    assert.equal(run.provider, "deepseek");
    assert.equal(run.model, "deepseek-v4-flash");
    assert.equal(run.thinking, "max");
    assert.equal(run.observedProvider, "deepseek");
    assert.equal(run.observedModel, "deepseek-v4-flash");
    assert.equal(run.supervisorAlive, true);
    assert.equal(run.childAlive, true);
    assert.equal(run.workdirExists, true);
    assert.equal(run.managedWorktree, true);
    // providerRetryCount must remain null if unknown
    assert.equal(run.providerRetryCount, null);
    // Must NOT assert process liveness means progress
    assert.ok(run.recommendations.some((r) => r.includes("Supervisor process is running")));
    assert.ok(!run.recommendations.some((r) => /actively in progress/i.test(r)));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("diagnose reports failed task with structured retryGuidance, native retry count, detectedAt, and redacted error", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-diagnose-failed-"));
  const env = testEnv(temporary);
  try {
    const detectedAt = new Date().toISOString();
    createRunFixture(env, "run-failed", {
      schema: 3,
      runId: "run-failed",
      backend: "claude",
      state: "failed",
      mode: "write",
      worker: { version: "0.3.0", brand: "subworker" },
      backendVersion: "2.1.252",
      reason: "Request failed with api_key=sk-secretkey1234567890abcdef authorization failed",
      reasonCode: "provider_error",
      providerRetryCount: 3,
      retryCount: 99, // Unrelated retryCount must NOT override providerRetryCount
      retryGuidance: {
        kind: "transient_auth",
        action: "refresh_credentials",
        retryOwner: "claude-bridge",
        message: "Refresh token for authorization: Bearer secret_bearer_token_12345",
      },
      attentions: [
        {
          category: "authentication",
          detail: "401 Unauthorized for token=secret_auth_token_9999",
          detectedAt,
        },
      ],
    });

    const output = command(["diagnose", "--run-id", "run-failed"], env).json;
    const run = output.runs[0];

    assert.equal(run.state, "failed");
    assert.equal(run.backend, "claude");
    assert.equal(run.backendVersion, "2.1.252");
    assert.equal(run.workerVersion, "0.3.0");
    // providerRetryCount uses native field only
    assert.equal(run.providerRetryCount, 3);

    // Structured retryGuidance preserved and sanitized
    assert.equal(typeof run.retryGuidance, "object");
    assert.equal(run.retryGuidance.kind, "transient_auth");
    assert.equal(run.retryGuidance.action, "refresh_credentials");
    assert.equal(run.retryGuidance.retryOwner, "claude-bridge");
    assert.ok(!run.retryGuidance.message.includes("secret_bearer_token_12345"));
    assert.ok(run.retryGuidance.message.includes("[REDACTED]"));

    // Redaction tests on explicitError and attention detail
    assert.ok(!run.explicitError.includes("sk-secretkey1234567890abcdef"));
    assert.ok(run.explicitError.includes("[REDACTED]"));
    assert.ok(run.explicitError.length <= 2048, "explicitError length must be bounded");
    assert.ok(!run.alerts[0].detail.includes("secret_auth_token_9999"));
    assert.ok(run.alerts[0].detail.includes("[REDACTED]"));

    // Attention uses detectedAt
    assert.equal(run.alerts[0].detectedAt, detectedAt);

    // Prefers recorded retry advice without implementing a second classifier
    assert.ok(run.recommendations.some((r) => r.includes("Retry guidance: Refresh token")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("diagnose distinguishes a missing run with compact truthful output", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-diagnose-missing-"));
  const env = testEnv(temporary);
  try {
    // 1. Completely absent run directory: exists must be false
    const outputAbsent = command(["diagnose", "--run-id", "absent-run"], env).json;
    assert.ok(Array.isArray(outputAbsent.runs));
    const runAbsent = outputAbsent.runs[0];
    assert.equal(runAbsent.runId, "absent-run");
    assert.equal(runAbsent.exists, false);
    assert.equal(runAbsent.state, "missing");
    assert.ok(runAbsent.recommendations.some((r) => r.includes("Run not found or already cleaned up")));
    assert.ok(Object.keys(runAbsent).length <= 5);

    // 2. Directory exists but result.json is missing: exists must keep true
    mkdirSync(join(env.SUBWORKER_STATE_ROOT, "dir-only-run"), { recursive: true });
    const outputDirOnly = command(["diagnose", "--run-id", "dir-only-run"], env).json;
    const runDirOnly = outputDirOnly.runs[0];
    assert.equal(runDirOnly.runId, "dir-only-run");
    assert.equal(runDirOnly.exists, true);
    assert.equal(runDirOnly.state, "missing");
    assert.ok(runDirOnly.recommendations.some((r) => r.includes("result.json is missing")));
    assert.ok(Object.keys(runDirOnly).length <= 5);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("diagnose reports unreadable run metadata as unavailable with neutral wording and actual error code", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-diagnose-unreadable-"));
  const env = testEnv(temporary);
  try {
    // 1. EACCES permission denied
    const dirPerm = createRunFixture(env, "unreadable-run", {
      runId: "unreadable-run",
      state: "running",
    });
    chmodSync(join(dirPerm, "result.json"), 0o000);

    const outputPerm = command(["diagnose", "--run-id", "unreadable-run"], env).json;
    const runPerm = outputPerm.runs[0];

    assert.equal(runPerm.runId, "unreadable-run");
    assert.equal(runPerm.exists, true);
    assert.equal(runPerm.state, "unavailable");
    assert.equal(runPerm.errorCode, "EACCES");
    assert.equal(runPerm.reason, "Permission denied reading run metadata");
    assert.ok(runPerm.recommendations.some((r) => r.includes("permission")));
    assert.ok(Object.keys(runPerm).length <= 6);

    // 2. Non-EACCES/EPERM I/O fault (e.g. result.json is a directory)
    const dirIo = join(env.SUBWORKER_STATE_ROOT, "io-error-run");
    mkdirSync(join(dirIo, "result.json"), { recursive: true }); // result.json as directory causes EISDIR on readFileSync
    const outputIo = command(["diagnose", "--run-id", "io-error-run"], env).json;
    const runIo = outputIo.runs[0];

    assert.equal(runIo.runId, "io-error-run");
    assert.equal(runIo.exists, true);
    assert.equal(runIo.state, "unavailable");
    assert.equal(runIo.errorCode, "EISDIR");
    assert.ok(!runIo.reason.includes("Permission denied"), "Non-EACCES error must not falsely claim Permission denied");
    assert.ok(runIo.reason.includes("Cannot read run metadata"), "Must use neutral cannot read wording");
  } finally {
    try {
      chmodSync(join(env.SUBWORKER_STATE_ROOT, "unreadable-run", "result.json"), 0o600);
    } catch {}
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("diagnose reports malformed or non-object result.json as malformed", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-diagnose-malformed-"));
  const env = testEnv(temporary);
  try {
    createRunFixture(env, "corrupt-json", "{ corrupted json here !!!");
    createRunFixture(env, "array-json", "[1, 2, 3]");

    const output = command(["diagnose", "--run-id", "corrupt-json", "--run-id", "array-json"], env).json;

    const run1 = output.runs[0];
    assert.equal(run1.runId, "corrupt-json");
    assert.equal(run1.exists, true);
    assert.equal(run1.state, "malformed");
    assert.ok(run1.reason.includes("JSON parse error"));
    assert.ok(run1.recommendations.some((r) => r.includes("corrupted or not a valid JSON object")));

    const run2 = output.runs[1];
    assert.equal(run2.runId, "array-json");
    assert.equal(run2.exists, true);
    assert.equal(run2.state, "malformed");
    assert.ok(run2.reason.includes("not a JSON object"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("diagnose handles multiple runs in a single invocation", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-diagnose-multi-"));
  const env = testEnv(temporary);
  try {
    createRunFixture(env, "run-a", {
      runId: "run-a",
      state: "settled",
      worker: { version: "0.3.0" },
    });
    createRunFixture(env, "run-b", {
      runId: "run-b",
      state: "running",
      worker: { version: "0.3.0" },
    });

    const multiFlags = command(["diagnose", "--run-id", "run-a", "--run-id", "run-b", "--run-id", "run-c"], env).json;
    assert.equal(multiFlags.runs.length, 3);
    assert.equal(multiFlags.runs[0].runId, "run-a");
    assert.equal(multiFlags.runs[0].exists, true);
    assert.equal(multiFlags.runs[1].runId, "run-b");
    assert.equal(multiFlags.runs[2].runId, "run-c");
    assert.equal(multiFlags.runs[2].exists, false);

    const commaSeparated = command(["diagnose", "--run-id", "run-a,run-c"], env).json;
    assert.equal(commaSeparated.runs.length, 2);
    assert.equal(commaSeparated.runs[0].runId, "run-a");
    assert.equal(commaSeparated.runs[1].runId, "run-c");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("diagnose is strictly read-only and causes no side effects or reconciliation", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-diagnose-readonly-"));
  const env = testEnv(temporary);
  try {
    const dir = createRunFixture(env, "vanished-run", {
      runId: "vanished-run",
      state: "running",
      activity: "thinking",
      supervisorPid: 99999999, // dead PID
      childPid: 99999998,
      worker: { version: "0.3.0" },
    });

    const beforeResultJson = readFileSync(join(dir, "result.json"), "utf8");

    const output = command(["diagnose", "--run-id", "vanished-run"], env).json;
    const run = output.runs[0];

    assert.equal(run.supervisorAlive, false);
    assert.equal(run.childAlive, false);
    assert.equal(run.state, "running");

    const afterResultJson = readFileSync(join(dir, "result.json"), "utf8");
    assert.equal(beforeResultJson, afterResultJson, "diagnose MUST NOT mutate result.json");
    assert.ok(!existsSync(join(dir, "failure.log")), "diagnose MUST NOT create failure.log or reconcile vanished run");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("diagnose distinguishes explicit Agy add-dirs from derived launcher workdir binding", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-diagnose-agy-workdir-"));
  const env = testEnv(temporary);
  try {
    const workdir = join(temporary, "target-workdir");
    mkdirSync(workdir, { recursive: true });

    createRunFixture(env, "agy-binding-run", {
      runId: "agy-binding-run",
      backend: "agy",
      state: "running",
      mode: "write",
      workdir,
      backendArgs: ["--add-dir", "/explicit/extra-dir", "--add-dir=/explicit/second-dir", "--effort", "high"],
    });

    const output = command(["diagnose", "--run-id", "agy-binding-run"], env).json;
    const run = output.runs[0];

    // Explicit dirs are cleanly separated from launcher automatic workdir binding
    assert.deepEqual(run.addDirs.explicit, ["/explicit/extra-dir", "/explicit/second-dir"]);
    assert.equal(run.addDirs.derivedWorkdir, workdir);
    // Does not claim an observed kernel permission fact
    assert.equal(run.taskConstraints.cliMode, "accept-edits");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("diagnose treats Pi path limits as prompt constraints, not an OS sandbox", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-diagnose-pi-path-"));
  const env = testEnv(temporary);
  try {
    createRunFixture(env, "pi-prompt-run", {
      runId: "pi-prompt-run",
      backend: "pi",
      state: "running",
      mode: "write",
      worker: { version: "0.3.0" },
    });

    const output = command(["diagnose", "--run-id", "pi-prompt-run"], env).json;
    const run = output.runs[0];

    assert.equal(run.taskConstraints.pathConstraint, "prompt-constrained (not an OS sandbox)");
    assert.match(run.taskConstraints.pathConstraint, /not an OS sandbox/);
    assert.ok(!JSON.stringify(run.recommendations).includes("OS sandbox"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("recommendations do not make unsupported claims and handle supervisor dead / child alive", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-diagnose-recommendations-"));
  const env = testEnv(temporary);
  try {
    // 1. Transport error must NOT assert network failure
    createRunFixture(env, "run-transport", {
      runId: "run-transport",
      state: "failed",
      backend: "pi",
      attentions: [{ category: "transport", detail: "socket hang up on stream chunk", detectedAt: new Date().toISOString() }],
    });
    const runTransport = command(["diagnose", "--run-id", "run-transport"], env).json.runs[0];
    assert.ok(!runTransport.recommendations.some((r) => /network/i.test(r)));
    assert.ok(runTransport.recommendations.some((r) => /transport stream error/i.test(r)));

    // 2. Read-mode permission error must NOT assert attempted write
    createRunFixture(env, "run-read-perm", {
      runId: "run-read-perm",
      state: "failed",
      backend: "pi",
      mode: "read",
      attentions: [{ category: "permission_denied", detail: "EACCES on directory traversal", detectedAt: new Date().toISOString() }],
    });
    const runReadPerm = command(["diagnose", "--run-id", "run-read-perm"], env).json.runs[0];
    assert.ok(!runReadPerm.recommendations.some((r) => /write operation was denied/i.test(r)));
    assert.ok(runReadPerm.recommendations.some((r) => /permission denied/i.test(r)));

    // 3. Rate limit must NOT recommend model/provider switching
    createRunFixture(env, "run-rate-limit", {
      runId: "run-rate-limit",
      state: "failed",
      backend: "pi",
      attentions: [{ category: "rate_limit", detail: "429 Too Many Requests", detectedAt: new Date().toISOString() }],
    });
    const runRateLimit = command(["diagnose", "--run-id", "run-rate-limit"], env).json.runs[0];
    assert.ok(!runRateLimit.recommendations.some((r) => /switch (?:to )?(?:another|different|backup) (?:model|provider)/i.test(r)));
    assert.ok(runRateLimit.recommendations.some((r) => /wait or back off/i.test(r)));

    // 4. Auth error is backend-specific
    createRunFixture(env, "run-auth-pi", {
      runId: "run-auth-pi",
      state: "failed",
      backend: "pi",
      attentions: [{ category: "authentication", detail: "invalid token", detectedAt: new Date().toISOString() }],
    });
    const runAuthPi = command(["diagnose", "--run-id", "run-auth-pi"], env).json.runs[0];
    assert.ok(runAuthPi.recommendations.some((r) => r.includes("~/.pi/agent/auth.json")));

    createRunFixture(env, "run-auth-claude", {
      runId: "run-auth-claude",
      state: "failed",
      backend: "claude",
      attentions: [{ category: "authentication", detail: "invalid api key", detectedAt: new Date().toISOString() }],
    });
    const runAuthClaude = command(["diagnose", "--run-id", "run-auth-claude"], env).json.runs[0];
    assert.ok(runAuthClaude.recommendations.some((r) => r.includes("Claude login or CommandCode credentials")));

    // 5. Cleanup advice must require host review first
    createRunFixture(env, "run-settled", {
      runId: "run-settled",
      state: "settled",
      backend: "pi",
    });
    const runSettled = command(["diagnose", "--run-id", "run-settled"], env).json.runs[0];
    assert.ok(runSettled.recommendations.some((r) => r.includes("The host IDE must review result.json and changes.patch")));

    // 6. Supervisor dead / child alive without automatic killing
    createRunFixture(env, "run-orphan", {
      runId: "run-orphan",
      state: "running",
      backend: "pi",
      supervisorPid: 99999999, // dead
      childPid: process.pid, // alive
    });
    const runOrphan = command(["diagnose", "--run-id", "run-orphan"], env).json.runs[0];
    assert.equal(runOrphan.supervisorAlive, false);
    assert.equal(runOrphan.childAlive, true);
    assert.ok(runOrphan.recommendations.some((r) => r.includes(`child process (PID ${process.pid}) is still alive`)));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("subworker binary launcher forwards diagnose command to events.mjs", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-diagnose-launcher-"));
  const env = testEnv(temporary);
  try {
    createRunFixture(env, "launcher-run", {
      runId: "launcher-run",
      backend: "pi",
      state: "settled",
      worker: { version: "0.3.0", brand: "subworker" },
    });

    const result = spawnSync("/bin/zsh", [launcher, "diagnose", "--run-id", "launcher-run"], {
      encoding: "utf8",
      env: {
        ...env,
        SUBWORKER_NODE_BIN: process.execPath,
      },
    });

    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed.runs));
    assert.equal(parsed.runs[0].runId, "launcher-run");
    assert.equal(parsed.runs[0].state, "settled");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("diagnose test fixture isolates against inherited SUBWORKER_STATE_ROOT using sentinel", () => {
  const sentinel = mkdtempSync(join(tmpdir(), "subworker-sentinel-"));
  const temporary = mkdtempSync(join(tmpdir(), "subworker-fixture-"));
  const prevSubworkerState = process.env.SUBWORKER_STATE_ROOT;
  const prevPiWorkerState = process.env.PI_WORKER_STATE_ROOT;
  process.env.SUBWORKER_STATE_ROOT = sentinel;
  try {
    const fixtureState = join(temporary, "state");
    const env = cleanSubprocessEnv({
      PI_WORKER_STATE_ROOT: fixtureState,
      SUBWORKER_NODE_BIN: process.execPath,
    });
    createRunFixture({ PI_WORKER_STATE_ROOT: fixtureState }, "sentinel-run", {
      schema: 3,
      runId: "sentinel-run",
      backend: "pi",
      state: "settled",
      worker: { version: "0.3.1", brand: "subworker" },
    });

    const output = command(["diagnose", "--run-id", "sentinel-run"], env).json;
    assert.ok(Array.isArray(output.runs));
    assert.equal(output.runs[0].runId, "sentinel-run");
    assert.equal(output.runs[0].exists, true);
    assert.equal(output.runs[0].state, "settled");

    const launcherResult = spawnSync("/bin/zsh", [launcher, "diagnose", "--run-id", "sentinel-run"], {
      encoding: "utf8",
      env,
    });
    assert.equal(launcherResult.status, 0, launcherResult.stderr);
    const launcherJson = JSON.parse(launcherResult.stdout);
    assert.equal(launcherJson.runs[0].runId, "sentinel-run");
    assert.equal(launcherJson.runs[0].exists, true);

    assert.equal(existsSync(sentinel), true);
    assert.deepEqual(readdirSync(sentinel), [], "Sentinel root must remain completely untouched");
  } finally {
    if (prevSubworkerState !== undefined) {
      process.env.SUBWORKER_STATE_ROOT = prevSubworkerState;
    } else {
      delete process.env.SUBWORKER_STATE_ROOT;
    }
    if (prevPiWorkerState !== undefined) {
      process.env.PI_WORKER_STATE_ROOT = prevPiWorkerState;
    } else {
      delete process.env.PI_WORKER_STATE_ROOT;
    }
    rmSync(sentinel, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});
