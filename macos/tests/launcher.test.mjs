import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const LAUNCHER = resolve(SCRIPT_DIR, "../bin/subworker");
const NODE_BIN = process.execPath;

function createSandbox() {
  const temporary = join(tmpdir(), `subworker-launcher-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(temporary, { recursive: true });
  return {
    path: temporary,
    cleanup() {
      try {
        rmSync(temporary, { recursive: true, force: true });
      } catch {}
    },
  };
}

function makeExecutableScript(filePath, content) {
  writeFileSync(filePath, content, { mode: 0o755 });
  try {
    chmodSync(filePath, 0o755);
  } catch {}
}

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

test("launcher help command forwards to events.mjs usage", () => {
  const result = spawnSync("/bin/zsh", [LAUNCHER, "help"], {
    encoding: "utf8",
    env: cleanSubprocessEnv({
      SUBWORKER_NODE_BIN: NODE_BIN,
    }),
  });
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stdout, /commands:/);
});

test("launcher --help and -h flags forward to events.mjs usage", () => {
  for (const flag of ["--help", "-h"]) {
    const result = spawnSync("/bin/zsh", [LAUNCHER, flag], {
      encoding: "utf8",
      env: cleanSubprocessEnv({
        SUBWORKER_NODE_BIN: NODE_BIN,
      }),
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /commands:/);
  }
});

test("launcher unknown command / typo fails with explicit error and does not invoke Pi", () => {
  const sandbox = createSandbox();
  try {
    const marker = join(sandbox.path, "pi-called.marker");
    const fakePi = join(sandbox.path, "fake-pi.sh");
    makeExecutableScript(fakePi, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);

    const result = spawnSync("/bin/zsh", [LAUNCHER, "dispacth", "--run-id", "test-1"], {
      encoding: "utf8",
      env: cleanSubprocessEnv({
        SUBWORKER_NODE_BIN: NODE_BIN,
        SUBWORKER_PI_BIN: fakePi,
      }),
    });

    assert.equal(result.status, 2, "Expected exit 2 on unknown command");
    assert.match(result.stderr, /Subworker: unknown command 'dispacth'/);
    assert.ok(!existsSync(marker), "Pi must NOT be invoked when an unknown command or typo is given");
  } finally {
    sandbox.cleanup();
  }
});

test("launcher missing command fails with explicit error and does not invoke Pi", () => {
  const sandbox = createSandbox();
  try {
    const marker = join(sandbox.path, "pi-called.marker");
    const fakePi = join(sandbox.path, "fake-pi.sh");
    makeExecutableScript(fakePi, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);

    const result = spawnSync("/bin/zsh", [LAUNCHER], {
      encoding: "utf8",
      env: cleanSubprocessEnv({
        SUBWORKER_NODE_BIN: NODE_BIN,
        SUBWORKER_PI_BIN: fakePi,
      }),
    });

    assert.equal(result.status, 2, "Expected exit 2 on missing command");
    assert.match(result.stderr, /Subworker: missing command/);
    assert.ok(!existsSync(marker), "Pi must NOT be invoked when launcher is run without arguments");
  } finally {
    sandbox.cleanup();
  }
});

test("regression: typo with PLAYWRIGHT_CLI_SESSION set still exits 2 and does not invoke Pi", () => {
  const sandbox = createSandbox();
  try {
    const marker = join(sandbox.path, "pi-called.marker");
    const fakePi = join(sandbox.path, "fake-pi.sh");
    makeExecutableScript(fakePi, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);

    const result = spawnSync("/bin/zsh", [LAUNCHER, "dispacth", "--run-id", "test-1"], {
      encoding: "utf8",
      env: cleanSubprocessEnv({
        SUBWORKER_NODE_BIN: NODE_BIN,
        SUBWORKER_PI_BIN: fakePi,
        PLAYWRIGHT_CLI_SESSION: "pi-worker-test-1",
      }),
    });

    assert.equal(result.status, 2, "Expected exit 2 on unknown command even with PLAYWRIGHT_CLI_SESSION set");
    assert.match(result.stderr, /Subworker: unknown command 'dispacth'/);
    assert.ok(!existsSync(marker), "Pi must NOT be invoked when typo occurs with PLAYWRIGHT_CLI_SESSION set");
  } finally {
    sandbox.cleanup();
  }
});

test("launcher explicit bare Pi via exec and raw subcommands invokes Pi with exact arguments", () => {
  const sandbox = createSandbox();
  try {
    const payloadFile = join(sandbox.path, "pi-args.json");
    const fakePi = join(sandbox.path, "fake-pi.sh");
    makeExecutableScript(fakePi, `#!/bin/sh
"${NODE_BIN}" -e 'import("node:fs").then(fs => fs.writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))))' "${payloadFile}" "$@"
exit 0
`);

    for (const subcmd of ["exec", "raw"]) {
      try { rmSync(payloadFile); } catch {}
      const result = spawnSync("/bin/zsh", [LAUNCHER, subcmd, "--model", "test-model", "hello world"], {
        encoding: "utf8",
        env: cleanSubprocessEnv({
          SUBWORKER_PI_BIN: fakePi,
        }),
      });

      assert.equal(result.status, 0, `Expected exit 0 for '${subcmd}'. stderr: ${result.stderr}`);
      assert.ok(existsSync(payloadFile), `Expected ${payloadFile} to be created for '${subcmd}'`);
      const recorded = JSON.parse(readFileSync(payloadFile, "utf8"));
      assert.ok(Array.isArray(recorded), "Recorded args must be an array");
      assert.ok(recorded.includes("--offline"), "Args must include --offline");
      assert.ok(recorded.includes("--model"), "Args must include --model");
      assert.ok(recorded.includes("test-model"), "Args must include test-model");
      assert.ok(recorded.includes("hello world"), "hello world must be preserved as a single argument");
      assert.ok(!recorded.includes("hello"), "hello world must not be split into hello");
      assert.ok(!recorded.includes("world"), "hello world must not be split into world");
    }
  } finally {
    sandbox.cleanup();
  }
});

test("environment variables: SUBWORKER_NODE_BIN takes precedence over legacy PI_WORKER_NODE_BIN", () => {
  const sandbox = createSandbox();
  try {
    const node1Marker = join(sandbox.path, "node1.marker");
    const node2Marker = join(sandbox.path, "node2.marker");
    const fakeNode1 = join(sandbox.path, "fake-node1.sh");
    const fakeNode2 = join(sandbox.path, "fake-node2.sh");

    makeExecutableScript(fakeNode1, `#!/bin/sh\ntouch "${node1Marker}"\nexit 0\n`);
    makeExecutableScript(fakeNode2, `#!/bin/sh\ntouch "${node2Marker}"\nexit 0\n`);

    // 1. Only SUBWORKER_NODE_BIN
    spawnSync("/bin/zsh", [LAUNCHER, "status", "--run-id", "test-run"], {
      env: cleanSubprocessEnv({ SUBWORKER_NODE_BIN: fakeNode1, PI_WORKER_NODE_BIN: "" }),
    });
    assert.ok(existsSync(node1Marker), "SUBWORKER_NODE_BIN should be used");
    rmSync(node1Marker);

    // 2. Only PI_WORKER_NODE_BIN (legacy fallback)
    spawnSync("/bin/zsh", [LAUNCHER, "status", "--run-id", "test-run"], {
      env: cleanSubprocessEnv({ SUBWORKER_NODE_BIN: "", PI_WORKER_NODE_BIN: fakeNode2 }),
    });
    assert.ok(existsSync(node2Marker), "Legacy PI_WORKER_NODE_BIN should be used as fallback");
    rmSync(node2Marker);

    // 3. Both set: SUBWORKER_NODE_BIN takes priority
    spawnSync("/bin/zsh", [LAUNCHER, "status", "--run-id", "test-run"], {
      env: cleanSubprocessEnv({ SUBWORKER_NODE_BIN: fakeNode1, PI_WORKER_NODE_BIN: fakeNode2 }),
    });
    assert.ok(existsSync(node1Marker), "SUBWORKER_NODE_BIN must take precedence over PI_WORKER_NODE_BIN");
    assert.ok(!existsSync(node2Marker), "PI_WORKER_NODE_BIN must NOT be used when SUBWORKER_NODE_BIN is set");
  } finally {
    sandbox.cleanup();
  }
});

test("environment variables: SUBWORKER_PI_BIN takes precedence over legacy PI_WORKER_PI_BIN", () => {
  const sandbox = createSandbox();
  try {
    const pi1Marker = join(sandbox.path, "pi1.marker");
    const pi2Marker = join(sandbox.path, "pi2.marker");
    const fakePi1 = join(sandbox.path, "fake-pi1.sh");
    const fakePi2 = join(sandbox.path, "fake-pi2.sh");

    makeExecutableScript(fakePi1, `#!/bin/sh\ntouch "${pi1Marker}"\nexit 0\n`);
    makeExecutableScript(fakePi2, `#!/bin/sh\ntouch "${pi2Marker}"\nexit 0\n`);

    // 1. Only SUBWORKER_PI_BIN
    spawnSync("/bin/zsh", [LAUNCHER, "exec", "test"], {
      env: cleanSubprocessEnv({ SUBWORKER_PI_BIN: fakePi1, PI_WORKER_PI_BIN: "" }),
    });
    assert.ok(existsSync(pi1Marker), "SUBWORKER_PI_BIN should be used");
    rmSync(pi1Marker);

    // 2. Only PI_WORKER_PI_BIN (legacy fallback)
    spawnSync("/bin/zsh", [LAUNCHER, "exec", "test"], {
      env: cleanSubprocessEnv({ SUBWORKER_PI_BIN: "", PI_WORKER_PI_BIN: fakePi2 }),
    });
    assert.ok(existsSync(pi2Marker), "Legacy PI_WORKER_PI_BIN should be used as fallback");
    rmSync(pi2Marker);

    // 3. Both set: SUBWORKER_PI_BIN takes priority
    spawnSync("/bin/zsh", [LAUNCHER, "exec", "test"], {
      env: cleanSubprocessEnv({ SUBWORKER_PI_BIN: fakePi1, PI_WORKER_PI_BIN: fakePi2 }),
    });
    assert.ok(existsSync(pi1Marker), "SUBWORKER_PI_BIN must take precedence over PI_WORKER_PI_BIN");
    assert.ok(!existsSync(pi2Marker), "PI_WORKER_PI_BIN must NOT be used when SUBWORKER_PI_BIN is set");
  } finally {
    sandbox.cleanup();
  }
});
