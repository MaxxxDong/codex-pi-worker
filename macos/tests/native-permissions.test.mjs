import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyNativePermissions } from "../lib/native-permissions.mjs";
import { agyLaunchArgs } from "../lib/agy-backend.mjs";
import { claudeLaunchArgs } from "../lib/claude-backend.mjs";

test("Grok runtime supplies bypass for new and legacy runs without global settings", () => {
  const flag = "--dangerously-skip-permissions";
  assert.deepEqual(applyNativePermissions("grok", []), [flag]);
  assert.deepEqual(applyNativePermissions("grok", [flag]), [flag]);
});

test("only explicit native global bypass opts a backend into the flag", () => {
  const home = mkdtempSync(join(tmpdir(), "sw-permissions-"));
  try {
    const flag = "--dangerously-skip-permissions";
    assert.deepEqual(applyNativePermissions("agy", [], home), []);
    for (const [backend, relative, settings] of [
      ["agy", ".gemini/antigravity-cli/settings.json", { toolPermission: "always-proceed" }],
      ["claude", ".claude/settings.json", { permissions: { defaultMode: "bypassPermissions" } }],
    ]) {
      const file = join(home, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(settings));
      assert.deepEqual(applyNativePermissions(backend, [], home), [flag]);
      assert.deepEqual(applyNativePermissions(backend, [flag], home), [flag]);
      writeFileSync(file, "{}");
      assert.deepEqual(applyNativePermissions(backend, [], home), []);
      assert.deepEqual(applyNativePermissions(backend, [flag], home), [flag]);
      writeFileSync(file, "{");
      assert.throws(() => applyNativePermissions(backend, [], home), /Cannot read/);
    }
    assert.deepEqual(applyNativePermissions("pi", ["--thinking", "max"], home), ["--thinking", "max"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("native launchers forward bypass without conflicting Claude permission mode", () => {
  const flag = "--dangerously-skip-permissions";
  const mode = { model: "test-model", thinking: "high", permissionMode: "auto" };
  const a = agyLaunchArgs({ args: [flag], prompt: "test", mode, hardTimeoutSeconds: 0 });
  const c = claudeLaunchArgs({ args: [flag], prompt: "test", mode });
  assert.ok(a.includes(flag));
  assert.ok(c.includes(flag));
  assert.ok(!c.includes("--permission-mode"));
});
