#!/usr/bin/env python3
"""Trim the shared Pi dependency cache when no Worker is using it."""

from __future__ import annotations

import argparse
from pathlib import Path

from runtime_support import runtime_lock, trim_cache_if_idle


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    root = args.runtime_root.resolve()
    with runtime_lock(root):
        trim_cache_if_idle(root, force=args.force)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
