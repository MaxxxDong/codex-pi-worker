import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateToolCall } from "../scripts/pi_worker_guard.mjs";

function policy(root) {
  return {
    cwd: path.join(root, "worktree"),
    sourceCwd: path.join(root, "source"),
    home: path.join(root, "home"),
  };
}

test("allows read-only access to the source checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
  const p = policy(root);
  fs.mkdirSync(p.cwd, { recursive: true });
  fs.mkdirSync(p.sourceCwd, { recursive: true });
  assert.equal(evaluateToolCall("read", { path: path.join(p.sourceCwd, "README.md") }, p), null);
  assert.equal(evaluateToolCall("bash", { command: `rg TODO "${p.sourceCwd}"` }, p), null);
});

test("allows writes inside the execution worktree only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
  const p = policy(root);
  fs.mkdirSync(p.cwd, { recursive: true });
  fs.mkdirSync(p.sourceCwd, { recursive: true });
  assert.equal(evaluateToolCall("write", { path: path.join(p.cwd, "ok.txt") }, p), null);
  assert.match(evaluateToolCall("edit", { path: path.join(p.sourceCwd, "bad.txt") }, p), /outside/i);
  assert.match(evaluateToolCall("write", { path: path.join(p.home, "bad.txt") }, p), /outside/i);
});

test("blocks recursive deletion and destructive disk commands", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
  const p = policy(root);
  fs.mkdirSync(p.cwd, { recursive: true });
  for (const command of [
    "rm -rf C:/",
    "Remove-Item -LiteralPath $HOME -Recurse -Force",
    "cmd /c rd /s /q C:\\Users",
    "git clean -fdx",
    "python -c \"import shutil; shutil.rmtree('C:/')\"",
    "node -e \"require('fs').rmSync('C:/', {recursive:true})\"",
    "format C:",
  ]) {
    assert.match(evaluateToolCall("bash", { command }, p), /blocked|recursive|destructive/i, command);
  }
});

test("allows a precise recursive delete below the execution worktree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
  const p = policy(root);
  fs.mkdirSync(path.join(p.cwd, "build"), { recursive: true });
  assert.equal(evaluateToolCall("bash", { command: "rm -rf ./build" }, p), null);
  assert.equal(
    evaluateToolCall("bash", { command: "Remove-Item -LiteralPath .\\build -Recurse -Force" }, p),
    null,
  );
  assert.match(evaluateToolCall("bash", { command: "rm -rf ." }, p), /unsafe recursive/i);
  assert.match(evaluateToolCall("bash", { command: "rm -rf ./build*" }, p), /unsafe recursive/i);
});

test("blocks source mutation or execution but not source inspection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
  const p = policy(root);
  fs.mkdirSync(p.cwd, { recursive: true });
  fs.mkdirSync(p.sourceCwd, { recursive: true });
  assert.equal(evaluateToolCall("bash", { command: `cd "${p.sourceCwd}"; git diff --stat` }, p), null);
  assert.match(
    evaluateToolCall("bash", { command: `cd "${p.sourceCwd}"; ./gradlew test` }, p),
    /source checkout/i,
  );
  assert.equal(evaluateToolCall("bash", { command: "git status --short" }, p), null);
});

test("keeps mutation and execution paths inside the execution worktree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
  const p = policy(root);
  const inside = path.join(p.cwd, "scripts", "check.mjs");
  const outside = path.join(root, "outside", "check.mjs");
  fs.mkdirSync(path.dirname(inside), { recursive: true });

  assert.match(evaluateToolCall("bash", { command: "node ..\\outside\\check.mjs" }, p), /outside/i);
  assert.match(evaluateToolCall("bash", { command: `node "${outside}"` }, p), /outside/i);
  assert.equal(evaluateToolCall("bash", { command: `node "${inside}"` }, p), null);
  assert.equal(evaluateToolCall("bash", { command: `rg TODO "${p.sourceCwd}"` }, p), null);
  assert.equal(evaluateToolCall("bash", { command: `rg TODO "${p.home}"` }, p), null);
});

test("allows shell syntax that is not an outside path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
  const p = policy(root);
  fs.mkdirSync(p.cwd, { recursive: true });
  assert.equal(evaluateToolCall("bash", { command: "git status --short 2>/dev/null" }, p), null);
  assert.equal(evaluateToolCall("bash", { command: "echo a | tr '/' '_' > result.txt" }, p), null);
  assert.equal(evaluateToolCall("bash", { command: "curl https://example.com \\\n    -o page.html" }, p), null);
  assert.match(evaluateToolCall("bash", { command: "mkdir /tmp/out" }, p), /outside/i);
  assert.match(evaluateToolCall("bash", { command: "mkdir '/'" }, p), /outside/i);
});

test("allows only the pinned Playwright wrapper outside the worktree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
  const p = { ...policy(root), agentDir: path.join(root, "home", ".pi", "agent") };
  fs.mkdirSync(p.cwd, { recursive: true });
  const script = path.join(
    p.agentDir,
    "npm",
    "node_modules",
    "pi-playwright",
    "skills",
    "playwright-browser",
    "scripts",
    "pw.js",
  );
  assert.equal(evaluateToolCall("bash", { command: `node "${script}" open about:blank` }, p), null);
  assert.match(
    evaluateToolCall("bash", { command: `node "${script}" screenshot --filename "${p.home}\\bad.png"` }, p),
    /home|outside/i,
  );
  assert.equal(
    evaluateToolCall("bash", { command: `node "${script}" eval '() => document.title'` }, p),
    null,
  );
  assert.match(evaluateToolCall("bash", { command: `node "${script}" close; rm -rf C:/` }, p), /recursive/i);
});

test("blocks symlink or junction escapes for direct write tools", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
  const p = policy(root);
  fs.mkdirSync(p.cwd, { recursive: true });
  fs.mkdirSync(p.home, { recursive: true });
  fs.symlinkSync(p.home, path.join(p.cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.match(evaluateToolCall("write", { path: path.join(p.cwd, "escape", "bad.txt") }, p), /outside/i);
});
