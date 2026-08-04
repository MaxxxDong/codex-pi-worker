"""Small shared runtime helpers for Pi worker lifecycle and cache ownership."""

from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

CACHE_LIMIT_BYTES = 20 * 1024**3
CACHE_TARGET_BYTES = 19 * 1024**3
CACHE_CHECK_INTERVAL_SECONDS = 3600
RUN_TEMP_STALE_SECONDS = 3600
JOB_HISTORY_RETENTION_SECONDS = 7 * 24 * 3600
ATTENTION_EVENT_PREFIX = r"Local\pi-worker-attention-"
CANCEL_EVENT_PREFIX = r"Local\pi-worker-cancel-"
STEER_EVENT_PREFIX = r"Local\pi-worker-steer-"
STEER_ACK_EVENT_PREFIX = r"Local\pi-worker-steer-ack-"
DEFAULT_PROVIDER = "opencode-go"
DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_THINKING = "max"
PROVIDER_MODELS = {
    "opencode-go": {"deepseek-v4-flash"},
    "shuaiapi": {"gpt-5.6-luna", "gpt-5.6-sol"},
    "shuaiapi-grok": {"grok-4.5"},
    "krill": {"grok-4.5"},
    "krill-sol": {"gpt-5.6-sol"},
}
MODEL_CHOICES = tuple(sorted({model for models in PROVIDER_MODELS.values() for model in models}))
SAFE_ENV_NAMES = {
    "ALLUSERSPROFILE",
    "APPDATA",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "USERPROFILE",
    "WINDIR",
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "CARGO_HOME",
    "DOTNET_ROOT",
    "GOPATH",
    "GOROOT",
    "GRADLE_USER_HOME",
    "JAVA_HOME",
    "M2_HOME",
    "MAVEN_HOME",
    "NODE_PATH",
    "NPM_CONFIG_PREFIX",
    "PNPM_HOME",
    "PYTHONIOENCODING",
    "PYTHONPATH",
    "PYTHONUTF8",
    "RUSTUP_HOME",
    "VIRTUAL_ENV",
    "CI",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "TERM",
    "XDG_CONFIG_HOME",
    "PI_CODING_AGENT_DIR",
    "PI_WORKER_DISABLE_CACHE_GC",
    "PI_ALLOW_BROWSER_COOKIES",
    "FEYNMAN_ALLOW_BROWSER_COOKIES",
    "OPENCODE_API_KEY",
    "BRAVE_API_KEY",
    "CLOUDFLARE_API_KEY",
    "EXA_API_KEY",
    "FIRECRAWL_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GEMINI_BASE_URL",
    "PARALLEL_API_KEY",
    "PERPLEXITY_API_KEY",
    "TAVILY_API_KEY",
}


def emit_json(value: dict[str, object]) -> None:
    """Write portable JSON even when Windows stdout still uses CP936/GBK."""
    print(json.dumps(value, ensure_ascii=True), flush=True)


def attention_event_name(run_id: str) -> str:
    return f"{ATTENTION_EVENT_PREFIX}{run_id}"


def cancel_event_name(run_id: str) -> str:
    return f"{CANCEL_EVENT_PREFIX}{run_id}"


def steer_event_name(run_id: str) -> str:
    return f"{STEER_EVENT_PREFIX}{run_id}"


def steer_ack_event_name(message_id: str) -> str:
    return f"{STEER_ACK_EVENT_PREFIX}{message_id}"


def create_attention_event(name: str) -> int | None:
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateEventW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR)
    kernel32.CreateEventW.restype = ctypes.c_void_p
    handle = kernel32.CreateEventW(None, True, False, name)
    if not handle:
        raise OSError(ctypes.get_last_error(), f"CreateEventW failed for {name}")
    return int(handle)


def set_attention_event(handle: int | None) -> None:
    if handle is None:
        return
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.SetEvent.argtypes = (ctypes.c_void_p,)
    kernel32.SetEvent.restype = ctypes.c_int
    if not kernel32.SetEvent(ctypes.c_void_p(handle)):
        raise OSError(ctypes.get_last_error(), "SetEvent failed")


def reset_attention_event(handle: int | None) -> None:
    if handle is None:
        return
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.ResetEvent.argtypes = (ctypes.c_void_p,)
    kernel32.ResetEvent.restype = ctypes.c_int
    if not kernel32.ResetEvent(ctypes.c_void_p(handle)):
        raise OSError(ctypes.get_last_error(), "ResetEvent failed")


def wait_windows_event(handle: int, timeout_seconds: float | None = None) -> bool:
    if os.name != "nt":
        raise OSError("named event waiting is only available on Windows")
    import ctypes

    timeout_ms = 0xFFFFFFFF if timeout_seconds is None else max(0, round(timeout_seconds * 1000))
    result = ctypes.windll.kernel32.WaitForSingleObject(ctypes.c_void_p(handle), timeout_ms)
    if result == 0:
        return True
    if result == 0x102:
        return False
    raise OSError(ctypes.get_last_error(), "WaitForSingleObject failed")


def close_windows_handle(handle: int | None) -> None:
    if handle is not None and os.name == "nt":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        kernel32.CloseHandle.restype = ctypes.c_int
        kernel32.CloseHandle(ctypes.c_void_p(handle))


def runtime_root() -> Path:
    default = Path(r"C:\piw") if os.name == "nt" else Path.home() / ".cache" / "pi-worker"
    return Path(os.environ.get("PI_WORKER_ROOT", default)).resolve()


def is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _windows_extended_path(path: Path) -> str:
    value = str(path)
    if value.startswith("\\\\?\\"):
        return value
    if value.startswith("\\\\"):
        return "\\\\?\\UNC\\" + value[2:]
    return "\\\\?\\" + value


def _plain_windows_path(path: str) -> Path:
    if path.startswith("\\\\?\\UNC\\"):
        return Path("\\\\" + path[8:])
    if path.startswith("\\\\?\\"):
        return Path(path[4:])
    return Path(path)


def remove_owned_tree(path: Path, owned_root: Path) -> bool:
    """Remove one owned subtree without following links or failing on MAX_PATH."""
    root = owned_root.resolve()
    target = path.resolve()
    if target == root or not is_within(target, root):
        raise ValueError(f"refusing cleanup outside owned root: {target}")
    if not target.exists():
        return False
    if target.is_symlink() or (hasattr(os.path, "isjunction") and os.path.isjunction(target)):
        raise ValueError(f"refusing linked cleanup target: {target}")

    def onerror(func: object, failed: str, exc_info: object) -> None:
        candidate = _plain_windows_path(failed).resolve()
        if candidate != target and not is_within(candidate, target):
            raise ValueError(f"cleanup callback escaped target: {candidate}")
        error = exc_info[1] if isinstance(exc_info, tuple) else None
        if isinstance(error, PermissionError) and callable(func):
            os.chmod(failed, stat.S_IWRITE)
            func(failed)
            return
        if isinstance(error, BaseException):
            raise error
        raise OSError(f"failed to remove {candidate}")

    shutil.rmtree(_windows_extended_path(target) if os.name == "nt" else target, onerror=onerror)
    return True


def atomic_json(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            fd = -1
            handle.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        for attempt in range(10):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if os.name != "nt" or attempt == 9:
                    raise
                time.sleep(0.005 * (attempt + 1))
    finally:
        if fd >= 0:
            os.close(fd)
        temporary.unlink(missing_ok=True)


def validate_route(provider: str, model: str) -> None:
    if model not in PROVIDER_MODELS.get(provider, set()):
        raise SystemExit(f"model {model} is not configured for provider {provider}")


def record_job(root: Path, job_id: str, **values: object) -> dict[str, object]:
    path = root / "jobs" / f"{job_id}.json"
    with runtime_lock(root):
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            current = {"jobId": job_id, "createdAtEpoch": time.time()}
        same_turn = current.get("latestRunId") == values.get("latestRunId")
        if same_turn and current.get("state") in {"pending_review", "settled"} and values.get("state") in {
            "starting",
            "running",
            "orphaned",
        }:
            return current
        current.update(values)
        current["updatedAtEpoch"] = time.time()
        atomic_json(path, current)
        return current


def remove_job(root: Path, job_id: str) -> None:
    (root / "jobs" / f"{job_id}.json").unlink(missing_ok=True)


def reconcile_jobs(root: Path) -> dict[str, int]:
    jobs = root / "jobs"
    jobs.mkdir(parents=True, exist_ok=True)
    counts = {
        "running": 0,
        "pendingReview": 0,
        "orphaned": 0,
        "settled": 0,
        "runDirsRemoved": 0,
        "untrackedWorktrees": 0,
    }
    now = time.time()
    tracked_worktrees: set[Path] = set()
    for path in jobs.glob("*.json"):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            counts["orphaned"] += 1
            continue
        state = str(job.get("state") or "orphaned")
        if job.get("worktreePath"):
            tracked_worktrees.add(Path(str(job["worktreePath"])).resolve())
        if state == "settled" and now - float(job.get("updatedAtEpoch") or 0) > JOB_HISTORY_RETENTION_SECONDS:
            path.unlink(missing_ok=True)
            continue
        if state in {"starting", "running"} and not pid_alive(int(job.get("pid") or 0)):
            result_path = Path(str(job.get("resultPath") or ""))
            state = "pending_review" if result_path.is_file() else "orphaned"
            job.update({"state": state, "pid": 0, "reconciledAtEpoch": time.time()})
            atomic_json(path, job)
        key = {
            "starting": "running",
            "running": "running",
            "pending_review": "pendingReview",
            "orphaned": "orphaned",
            "settled": "settled",
        }.get(state, "orphaned")
        counts[key] += 1
    active_run_ids = {path.stem for path in _active_markers(root)}
    runs = root / "runs"
    if runs.is_dir():
        for run_dir in runs.iterdir():
            try:
                if (
                    run_dir.is_dir()
                    and run_dir.name not in active_run_ids
                    and now - run_dir.stat().st_mtime > RUN_TEMP_STALE_SECONDS
                ):
                    remove_owned_tree(run_dir, runs)
                    counts["runDirsRemoved"] += 1
            except OSError:
                continue
    worktrees = root / "worktrees"
    if worktrees.is_dir():
        counts["untrackedWorktrees"] = sum(
            child.is_dir() and child.resolve() not in tracked_worktrees for child in worktrees.iterdir()
        )
    return counts


def terminate_process_tree(process: object) -> None:
    stdin = getattr(process, "stdin", None)
    if stdin is not None and not stdin.closed:
        stdin.close()
    poll = getattr(process, "poll")
    if poll() is not None:
        return
    if os.name == "nt":
        import subprocess

        subprocess.run(
            ["taskkill", "/PID", str(getattr(process, "pid")), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
        try:
            getattr(process, "wait")(timeout=5)
        except subprocess.TimeoutExpired:
            getattr(process, "kill")()
            getattr(process, "wait")(timeout=5)
    else:
        getattr(process, "kill")()
        getattr(process, "wait")(timeout=5)


@contextmanager
def runtime_lock(root: Path) -> Iterator[None]:
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / "runtime.lock"
    with lock_path.open("a+b") as lock:
        lock.seek(0, os.SEEK_END)
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        synchronize = 0x00100000
        wait_timeout = 0x00000102
        handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            return False
        try:
            return ctypes.windll.kernel32.WaitForSingleObject(handle, 0) == wait_timeout
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _active_markers(root: Path) -> list[Path]:
    active = root / "active"
    active.mkdir(parents=True, exist_ok=True)
    now = time.time()
    live: list[Path] = []
    for marker in active.glob("*.json"):
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
            pid = int(data.get("pid") or 0)
            reserved_at = float(data.get("reservedAtEpoch") or 0)
            if pid_alive(pid) or (pid == 0 and now - reserved_at < 300):
                live.append(marker)
            else:
                marker.unlink(missing_ok=True)
        except (OSError, ValueError, json.JSONDecodeError):
            marker.unlink(missing_ok=True)
    return live


def shared_cache_paths(root: Path) -> dict[str, Path]:
    cache_root = (root / "cache").resolve()
    paths = {
        "uv": Path(os.environ.get("UV_CACHE_DIR", cache_root / "uv")).resolve(),
        "pip": Path(os.environ.get("PIP_CACHE_DIR", cache_root / "pip")).resolve(),
        "npm": Path(os.environ.get("npm_config_cache", cache_root / "npm")).resolve(),
    }
    for path in paths.values():
        path.mkdir(parents=True, exist_ok=True)
    atomic_json(root / "cache-roots.json", {name: str(path) for name, path in paths.items()})
    return paths


def managed_cache_paths(root: Path) -> dict[str, Path]:
    # cache-roots.json is informational only; cleanup authority comes from the
    # runtime root and explicit process environment, never mutable metadata.
    return shared_cache_paths(root)


def cache_size(caches: Iterable[Path]) -> int:
    total = 0
    for cache in caches:
        if not cache.is_dir():
            continue
        for path in cache.rglob("*"):
            try:
                if path.is_file() and not path.is_symlink():
                    total += path.stat().st_size
            except OSError:
                continue
    return total


def _last_cache_status(root: Path) -> dict[str, object]:
    path = root / "cache-status.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"checked": False, "afterBytes": None, "trimmed": False}


def trim_cache_if_idle(root: Path, *, force: bool = False) -> dict[str, object]:
    caches = list(dict.fromkeys(path.resolve() for path in managed_cache_paths(root).values()))
    live = _active_markers(root)
    previous = _last_cache_status(root)
    if live:
        return {**previous, "checked": False, "trimmed": False, "activeWorkers": len(live)}
    now = time.time()
    last_checked = float(previous.get("checkedAtEpoch") or 0)
    if not force and now - last_checked < CACHE_CHECK_INTERVAL_SECONDS:
        return {**previous, "checked": False, "trimmed": False, "activeWorkers": 0}

    before = cache_size(caches)
    if before <= CACHE_LIMIT_BYTES:
        status = {
            "checked": True,
            "checkedAtEpoch": now,
            "beforeBytes": before,
            "afterBytes": before,
            "trimmed": False,
            "activeWorkers": 0,
        }
        atomic_json(root / "cache-status.json", status)
        return status

    files: list[tuple[float, int, Path]] = []
    for cache in caches:
        for path in cache.rglob("*"):
            try:
                if path.is_file() and not path.is_symlink():
                    stat = path.stat()
                    files.append((stat.st_mtime, stat.st_size, path))
            except OSError:
                continue
    current = before
    for _, size, path in sorted(files):
        if current <= CACHE_TARGET_BYTES:
            break
        try:
            path.unlink()
            current -= size
        except OSError:
            continue
    for cache in caches:
        for directory in sorted((p for p in cache.rglob("*") if p.is_dir()), reverse=True):
            try:
                directory.rmdir()
            except OSError:
                pass
    status = {
        "checked": True,
        "checkedAtEpoch": now,
        "beforeBytes": before,
        "afterBytes": cache_size(caches),
        "trimmed": True,
        "activeWorkers": 0,
    }
    atomic_json(root / "cache-status.json", status)
    return status


def reserve_cache(root: Path, run_id: str) -> dict[str, object]:
    with runtime_lock(root):
        live = _active_markers(root)
        status = {**_last_cache_status(root), "activeWorkers": len(live)}
        atomic_json(
            root / "active" / f"{run_id}.json",
            {"runId": run_id, "pid": 0, "reservedAtEpoch": time.time()},
        )
        return status


def activate_cache(root: Path, run_id: str, pid: int) -> None:
    with runtime_lock(root):
        atomic_json(
            root / "active" / f"{run_id}.json",
            {"runId": run_id, "pid": pid, "reservedAtEpoch": time.time()},
        )


def release_cache(root: Path, run_id: str) -> dict[str, object]:
    with runtime_lock(root):
        (root / "active" / f"{run_id}.json").unlink(missing_ok=True)
        live = _active_markers(root)
        return {**_last_cache_status(root), "activeWorkers": len(live), "gcEligible": not live}


def worker_environment(root: Path, run_id: str) -> tuple[dict[str, str], Path]:
    run_temp = root / "runs" / run_id / "tmp"
    buckets = shared_cache_paths(root)
    run_temp.mkdir(parents=True, exist_ok=True)
    env = {name: value for name, value in os.environ.items() if name.upper() in SAFE_ENV_NAMES}
    env.update(
        {
            "UV_CACHE_DIR": str(buckets["uv"]),
            "PIP_CACHE_DIR": str(buckets["pip"]),
            "npm_config_cache": str(buckets["npm"]),
            "TMP": str(run_temp),
            "TEMP": str(run_temp),
        }
    )
    return env, run_temp


def remove_run_temp(root: Path, run_id: str) -> None:
    run_dir = (root / "runs" / run_id).resolve()
    runs_root = (root / "runs").resolve()
    if run_dir.is_dir() and is_within(run_dir, runs_root):
        delays = (0.1, 0.2, 0.4, 0.8) if os.name == "nt" else ()
        for delay in (*delays, None):
            try:
                remove_owned_tree(run_dir, runs_root)
                return
            except OSError as error:
                if delay is None or not (
                    isinstance(error, PermissionError) or getattr(error, "winerror", None) in {5, 32}
                ):
                    raise
                time.sleep(delay)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
