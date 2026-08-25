#!/usr/bin/env python3
"""Make pi-playwright 0.1.1 launch its JavaScript CLI correctly on Windows."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

OLD = "  const result = spawnSync(bin, finalArgs, {\n"
NEW = """  const command = process.platform === \"win32\" ? process.execPath : bin;
  const commandArgs = process.platform === \"win32\"
    ? [join(packageRoot, \"node_modules\", \"@playwright\", \"cli\", \"playwright-cli.js\"), ...finalArgs]
    : finalArgs;
  const result = spawnSync(command, commandArgs, {
"""


def patch_runtime(runtime: Path, backup: Path) -> bool:
    text = runtime.read_text(encoding="utf-8")
    if NEW in text:
        return False
    if OLD not in text:
        raise RuntimeError("unsupported pi-playwright runtime.js; expected 0.1.1 layout")
    backup.parent.mkdir(parents=True, exist_ok=True)
    if not backup.exists():
        shutil.copy2(runtime, backup)
    runtime.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    return True


def main() -> int:
    agent = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi" / "agent")).resolve()
    package = agent / "npm" / "node_modules" / "pi-playwright"
    runtime = package / "skills" / "playwright-browser" / "scripts" / "lib" / "runtime.js"
    cli = package / "node_modules" / "@playwright" / "cli" / "playwright-cli.js"
    if not runtime.is_file() or not cli.is_file():
        raise SystemExit("install pi-playwright@0.1.1 and run npm install in its package directory first")
    changed = patch_runtime(runtime, agent / "backups" / "pi-playwright-runtime-before-windows.js")
    print(json.dumps({"status": "patched" if changed else "already_patched", "runtime": str(runtime)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
