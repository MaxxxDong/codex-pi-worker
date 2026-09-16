import assert from 'node:assert/strict';
import test from 'node:test';
import nativeTools from '../scripts/pi_worker_native_tools.mjs';

test('native tools preserve extensions and enable optional search and PowerShell', async () => {
  let handler;
  let actual;
  nativeTools({
    on: (name, callback) => { assert.equal(name, 'session_start'); handler = callback; },
    getActiveTools: () => ['read', 'edit', 'write', 'bash', 'mcp', 'web_search'],
    getAllTools: () => ['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls', 'powershell', 'mcp', 'web_search'].map(name => ({ name })),
    setActiveTools: names => { actual = names; },
  });
  await handler();
  assert.deepEqual(new Set(actual), new Set(['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls', 'powershell', 'mcp', 'web_search']));
});
