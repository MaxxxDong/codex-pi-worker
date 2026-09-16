import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

function processAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function redactText(value) {
  return String(value ?? "")
    .replace(/((?:authorization|api[_-]?key|token|secret|cookie)\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|nb)_[A-Za-z0-9_-]{16,}\b|\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
}

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return { ok: false, status: "not_found" };
    const content = readFileSync(path, "utf8");
    try {
      const data = JSON.parse(content);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { ok: false, status: "malformed", error: "Metadata is not a JSON object" };
      }
      return { ok: true, data };
    } catch (parseErr) {
      return { ok: false, status: "malformed", error: `JSON parse error: ${parseErr.message}` };
    }
  } catch (err) {
    return {
      ok: false,
      status: "unavailable",
      code: err.code || "ERR_IO",
      error: err.message,
    };
  }
}

function extractAddDirs(backendArgs, resultAddDirs) {
  const dirs = new Set();
  if (Array.isArray(resultAddDirs)) {
    for (const d of resultAddDirs) {
      if (d && typeof d === "string") dirs.add(d);
    }
  }
  if (Array.isArray(backendArgs)) {
    for (let i = 0; i < backendArgs.length; i++) {
      const arg = backendArgs[i];
      if (typeof arg !== "string") continue;
      if (arg.startsWith("--add-dir=")) {
        dirs.add(arg.slice("--add-dir=".length));
      } else if (arg === "--add-dir" && backendArgs[i + 1] && !backendArgs[i + 1].startsWith("-")) {
        dirs.add(backendArgs[i + 1]);
        i++;
      }
    }
  }
  return [...dirs];
}

function extractTaskConstraints(result) {
  const backend = result.backend ?? "pi";
  const mode = result.mode ?? "read";
  const args = Array.isArray(result.backendArgs) ? result.backendArgs : [];

  if (backend === "grok") {
    const bypass = args.includes("--dangerously-skip-permissions");
    return {
      permissionMode: bypass ? "bypass" : (mode === "read" ? "plan" : "acceptEdits"),
      dangerouslySkipPermissions: bypass,
      cliMode: bypass ? "bypassPermissions + always-approve" : (mode === "read" ? "plan" : "acceptEdits"),
    };
  }
  if (backend === "claude") {
    const bypass = args.includes("--dangerously-skip-permissions");
    return {
      permissionMode: bypass ? "bypass" : (mode === "read" ? "plan" : "auto"),
      dangerouslySkipPermissions: bypass,
      allowOrchestration: Boolean(result.backendOptions?.allowOrchestration || args.includes("--allow-orchestration")),
    };
  }
  if (backend === "agy") {
    const bypass = args.includes("--dangerously-skip-permissions");
    return {
      permissionMode: bypass ? "bypass" : (mode === "read" ? "plan" : "accept-edits"),
      dangerouslySkipPermissions: bypass,
      cliMode: mode === "read" ? "plan" : "accept-edits",
    };
  }
  return {
    permissionMode: mode === "read" ? "read-only (prompt-constrained)" : "workspace (prompt-constrained)",
    pathConstraint: "prompt-constrained (not an OS sandbox)",
  };
}

function extractErrorsAndAlerts(directory, result) {
  let explicitError = null;
  const reasonCode = result.reasonCode ?? null;

  if (result.reason) {
    explicitError = redactText(result.reason).slice(0, 2048);
  } else if (result.error) {
    const errorText = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
    explicitError = redactText(errorText).slice(0, 2048);
  }

  const toolErrors = [];
  if (Array.isArray(result.tools)) {
    for (const tool of result.tools) {
      if (tool.errorCount > 0 || tool.lastError) {
        toolErrors.push({
          tool: tool.name,
          errorCount: tool.errorCount ?? 1,
          lastError: tool.lastError ? redactText(tool.lastError).slice(0, 512) : null,
        });
      }
    }
  }

  let alerts = [];
  if (Array.isArray(result.attentions) && result.attentions.length > 0) {
    alerts = result.attentions.map((a) => ({
      category: a.category ?? "unknown",
      detail: redactText(a.detail ?? "").slice(0, 512),
      detectedAt: a.detectedAt ?? a.timestamp ?? null,
    }));
  } else if (result.attention) {
    alerts = [{
      category: result.attention.category ?? "unknown",
      detail: redactText(result.attention.detail ?? "").slice(0, 512),
      detectedAt: result.attention.detectedAt ?? result.attention.timestamp ?? null,
    }];
  } else {
    const attPath = join(directory, "attention.json");
    const attFile = readJsonSafe(attPath);
    if (attFile.ok && attFile.data) {
      const list = Array.isArray(attFile.data.events)
        ? attFile.data.events
        : (Array.isArray(attFile.data) ? attFile.data : []);
      alerts = list.map((a) => ({
        category: a.category ?? "unknown",
        detail: redactText(a.detail ?? "").slice(0, 512),
        detectedAt: a.detectedAt ?? a.timestamp ?? null,
      }));
    }
  }

  if (!explicitError && (result.state === "failed" || result.state === "cancelled")) {
    const logPath = result.failureLogPath || join(directory, "failure.log");
    try {
      if (existsSync(logPath)) {
        const stats = statSync(logPath);
        const size = stats.size;
        const readLen = Math.min(size, 2048);
        const buffer = Buffer.alloc(readLen);
        const fd = openSync(logPath, "r");
        try {
          readSync(fd, buffer, 0, readLen, Math.max(0, size - readLen));
          const snippet = redactText(buffer.toString("utf8")).slice(-1024).trim();
          if (snippet) {
            explicitError = snippet;
          }
        } finally {
          closeSync(fd);
        }
      }
    } catch {}
  }

  return {
    explicitError,
    reasonCode,
    toolErrors: toolErrors.slice(-5),
    alerts: alerts.slice(-5),
  };
}

function extractRetryFacts(result) {
  const providerRetryCount = (typeof result.providerRetryCount === "number" && Number.isFinite(result.providerRetryCount))
    ? result.providerRetryCount
    : (result.providerRetryCount !== undefined && result.providerRetryCount !== null ? result.providerRetryCount : null);

  let retryGuidance = null;
  if (result.retryGuidance && typeof result.retryGuidance === "object") {
    retryGuidance = {
      ...(result.retryGuidance.kind !== undefined ? { kind: redactText(result.retryGuidance.kind) } : {}),
      ...(result.retryGuidance.action !== undefined ? { action: redactText(result.retryGuidance.action) } : {}),
      ...(result.retryGuidance.retryOwner !== undefined ? { retryOwner: redactText(result.retryGuidance.retryOwner) } : {}),
      ...(result.retryGuidance.message !== undefined ? { message: redactText(result.retryGuidance.message) } : {}),
    };
  } else if (typeof result.retryGuidance === "string" && result.retryGuidance) {
    retryGuidance = redactText(result.retryGuidance);
  }

  return { providerRetryCount, retryGuidance };
}

function generateRecommendations({
  state,
  supervisorAlive,
  childAlive,
  childPid,
  alerts,
  explicitError,
  reasonCode,
  backend,
  workdir,
  workdirExists,
  retryGuidance,
  eventAgeSeconds,
}) {
  const recommendations = [];

  if (workdir && !workdirExists) {
    recommendations.push(`Working directory does not exist on disk: ${workdir}`);
  }

  const isTerminal = ["success", "settled", "failed", "cancelled"].includes(state);
  if (!isTerminal) {
    if (!supervisorAlive && childAlive) {
      recommendations.push(`Supervisor process is not running, but child process (PID ${childPid}) is still alive. The task may be orphaned; check the child process or coordinate termination via cancel.`);
    } else if (!supervisorAlive && !childAlive) {
      recommendations.push("Supervisor and child processes are no longer running, but the run state was not marked terminal. Check process exit status or inspect failure logs.");
    } else if (supervisorAlive) {
      recommendations.push("Supervisor process is running. Use 'subworker wait --run-id <id>' to await completion or attention alerts.");
      if (eventAgeSeconds !== null && eventAgeSeconds > 300) {
        recommendations.push("No new events received for over 5 minutes. Check provider connectivity or session activity.");
      }
    }
  }

  if (retryGuidance) {
    const advice = typeof retryGuidance === "object"
      ? (retryGuidance.message || retryGuidance.action || retryGuidance.kind)
      : retryGuidance;
    if (advice) {
      recommendations.push(`Retry guidance: ${advice}`);
    }
  } else if (alerts && alerts.length > 0) {
    const latestAlert = alerts.at(-1);
    const category = latestAlert.category;
    if (category === "authentication") {
      if (backend === "pi") {
        recommendations.push("Authentication error. Verify credentials in ~/.pi/agent/auth.json or relevant environment variables.");
      } else if (backend === "claude") {
        recommendations.push("Authentication error. Verify Claude login or CommandCode credentials.");
      } else if (backend === "agy") {
        recommendations.push("Authentication error. Verify Agy login status.");
      } else {
        recommendations.push("Authentication error. Verify provider credentials or backend authentication.");
      }
    } else if (category === "rate_limit") {
      recommendations.push("Provider rate limit reached. Wait or back off before retrying.");
    } else if (category === "transport") {
      recommendations.push("Transport stream error encountered (connection reset, stream interrupted, or upstream EOF). Check endpoint connectivity or stream logs.");
    } else if (category === "request_rejected") {
      recommendations.push("Provider rejected the request. Review request parameters and prompt content.");
    } else if (category === "permission_denied") {
      recommendations.push("Permission denied. Check filesystem permissions or whether a restricted action was attempted.");
    }
  }

  if (state === "failed" && !retryGuidance && (!alerts || alerts.length === 0)) {
    if (reasonCode === "supervisor_lost") {
      recommendations.push("Supervisor process terminated unexpectedly without writing a terminal result. Check system logs or exit signals.");
    } else if (explicitError) {
      recommendations.push(`Run failed: ${explicitError}.`);
    } else {
      recommendations.push("Run failed with an unknown error. Review failure logs.");
    }
  }

  if (state === "settled" || state === "success") {
    recommendations.push("Run completed. The host IDE must review result.json and changes.patch before settling with 'subworker cleanup --reviewed yes --run-id <id>'.");
  } else if (state === "cancelled") {
    recommendations.push("Run was cancelled. The host IDE must review any artifacts before releasing resources with 'subworker cleanup --reviewed yes --run-id <id>'.");
  }

  return recommendations;
}

export function diagnoseRun(root, runId) {
  const directory = join(root, runId);
  if (!existsSync(directory)) {
    return {
      runId,
      exists: false,
      state: "missing",
      recommendations: ["Run not found or already cleaned up. Verify the run ID."],
    };
  }

  const resultPath = join(directory, "result.json");
  const readResult = readJsonSafe(resultPath);

  if (!readResult.ok) {
    if (readResult.status === "unavailable") {
      const isPerm = readResult.code === "EACCES" || readResult.code === "EPERM";
      return {
        runId,
        exists: true,
        state: "unavailable",
        errorCode: readResult.code ?? null,
        reason: isPerm
          ? "Permission denied reading run metadata"
          : `Cannot read run metadata (${readResult.code || "I/O error"}: ${readResult.error})`,
        recommendations: isPerm
          ? ["Run metadata cannot be read due to file permissions. Check read access on the run directory."]
          : [`Run metadata cannot be read (${readResult.code || "I/O error"}). Inspect the file or storage device.`],
      };
    }
    if (readResult.status === "malformed") {
      return {
        runId,
        exists: true,
        state: "malformed",
        reason: readResult.error,
        recommendations: ["Run metadata file (result.json) is corrupted or not a valid JSON object. Inspect the file content."],
      };
    }
    return {
      runId,
      exists: true,
      state: "missing",
      recommendations: ["Run directory exists but result.json is missing. Verify the run directory."],
    };
  }

  const result = readResult.data;

  let workerVersion = "unknown";
  if (result.worker && typeof result.worker === "object" && result.worker.version) {
    workerVersion = String(result.worker.version);
  } else if (typeof result.worker === "string" && result.worker) {
    workerVersion = result.worker;
  }

  let backendVersion = "unknown";
  if (result.backendVersion && typeof result.backendVersion === "string") {
    backendVersion = result.backendVersion;
  }

  let workdirExists = false;
  if (result.workdir) {
    try {
      workdirExists = existsSync(result.workdir);
    } catch {
      workdirExists = false;
    }
  }

  const supervisorAlive = Boolean(result.supervisorPid && processAlive(result.supervisorPid));
  const childAlive = Boolean(result.childPid && processAlive(result.childPid));

  const last = Date.parse(result.lastEventAt ?? "");
  const eventAgeSeconds = Number.isFinite(last) ? Math.round((Date.now() - last) / 100) / 10 : null;

  const activitySince = Date.parse(result.activitySince ?? "");
  const activitySeconds = Number.isFinite(activitySince) ? Math.round((Date.now() - activitySince) / 100) / 10 : null;

  const explicitAddDirs = extractAddDirs(result.backendArgs, result.addDirs);
  const derivedWorkdirAddDir = result.backend === "agy" && result.workdir ? result.workdir : null;
  const taskConstraints = extractTaskConstraints(result);

  const { explicitError, reasonCode, toolErrors, alerts } = extractErrorsAndAlerts(directory, result);
  const { providerRetryCount, retryGuidance } = extractRetryFacts(result);

  const recommendations = generateRecommendations({
    state: result.state ?? "unknown",
    supervisorAlive,
    childAlive,
    childPid: result.childPid ?? null,
    alerts,
    explicitError,
    reasonCode,
    backend: result.backend ?? "unknown",
    workdir: result.workdir,
    workdirExists,
    retryGuidance,
    eventAgeSeconds,
  });

  return {
    runId,
    exists: true,
    state: result.state ?? "unknown",
    activity: result.activity ?? null,
    backend: result.backend ?? "unknown",
    workerVersion,
    backendVersion,
    provider: result.provider ?? null,
    model: result.model ?? null,
    thinking: result.thinking ?? null,
    observedProvider: result.observedProvider ?? null,
    observedModel: result.observedModel ?? null,
    observedThinking: result.observedThinking ?? null,
    supervisorPid: result.supervisorPid ?? null,
    supervisorAlive,
    childPid: result.childPid ?? null,
    childAlive,
    firstEventAt: result.firstEventAt ?? null,
    lastEventAt: result.lastEventAt ?? null,
    firstToolAt: result.firstToolAt ?? null,
    lastToolAt: result.lastToolAt ?? null,
    lastEventType: result.lastEventType ?? null,
    eventAgeSeconds,
    activitySeconds,
    elapsedSeconds: result.elapsedSeconds ?? null,
    workdir: result.workdir ?? null,
    workdirExists,
    managedWorktree: Boolean(result.managedWorktree),
    sourceRoot: result.sourceRoot ?? null,
    mode: result.mode ?? null,
    permissionMode: taskConstraints.permissionMode,
    taskConstraints,
    addDirs: {
      explicit: explicitAddDirs,
      derivedWorkdir: derivedWorkdirAddDir,
    },
    explicitError,
    reasonCode,
    toolErrors,
    alerts,
    providerRetryCount,
    retryGuidance,
    recommendations,
  };
}

export function diagnoseRuns(root, ids) {
  return {
    runs: ids.map((id) => diagnoseRun(root, id)),
  };
}
