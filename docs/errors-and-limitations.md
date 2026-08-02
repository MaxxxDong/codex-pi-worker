# 错误排查与已知限制

本文面向 Pi Worker 的维护者和调用方，说明如何从 receipt、result、attention 与运行日志定位问题。设计演进背景见 [history.md](history.md)。

> 安全提示：不要把 `~/.pi/agent/models.json`、API Key、Cookie 或完整环境变量写进 issue、日志和提交。下文只使用 `<provider>`、`<model>`、`<output-dir>` 等占位符。

## 1. 先识别四类文件

一次首轮执行的输出目录通常包含：

- `pi-receipt.json`：启动回执和所有权凭据，包含进程、session、worktree、结果路径及 owner/latest receipt 关系。
- `pi-result.json`：终态结果。重点字段是 `status`、`success`、`exitCode`、`timedOut`、`stopReason`、`runnerError`、`evidenceTruncated`、`reasoningWarning` 和 `nextAction`。
- `pi-attention.json` 或 `pi-attention-delivered.json`：需要调用方介入的异常类别；watch 交付后会把前者改名为后者，避免重复交付。
- `pi-events.jsonl`、`pi-stderr.log`、`runtime.stdout.log`、`runtime.stderr.log`：压缩后的模型事件、Pi 标准错误和后台 runner 启动日志。

续跑输出位于 `turns/turn-NNN/`，但 owner receipt 仍是首轮的 `pi-receipt.json`。不要只看首轮 `pi-result.json` 判断最新状态；应从 owner receipt 的 `latestReceiptPath` 继续追踪。

常用 PowerShell 检查：

```powershell
$out = Resolve-Path '<output-dir>'
$receipt = Get-Content "$out\pi-receipt.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$receipt | Select-Object runId,status,pid,mode,provider,model,turnIndex,latestReceiptPath,cleanupStatus

$latest = Get-Content $receipt.latestReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (Test-Path $latest.resultPath) {
  Get-Content $latest.resultPath -Raw -Encoding UTF8 | ConvertFrom-Json |
    Select-Object status,success,exitCode,timedOut,timeoutMode,stopReason,runnerError,evidenceTruncated,reasoningWarning,nextAction
}
```

检查进程、worktree 和运行时登记：

```powershell
Get-Process -Id $latest.pid -ErrorAction SilentlyContinue
git -C $receipt.sourceRoot worktree list --porcelain
Get-ChildItem 'C:\piw\jobs' -Filter '*.json' -ErrorAction SilentlyContinue
```

如果设置了 `PI_WORKER_ROOT`，用该值替换默认的 `C:\piw`：

```powershell
$runtime = if ($env:PI_WORKER_ROOT) { $env:PI_WORKER_ROOT } else { 'C:\piw' }
```

## 2. 启动阶段错误

### 2.1 `implementation mode requires a clean source worktree`

实现模式会从当前 `HEAD` 创建 detached worktree。源仓库存在已跟踪或未跟踪改动时，无法明确哪些内容属于用户、哪些内容应交给 Worker，因此启动会被拒绝。

```powershell
git -C '<repo>' status --short --untracked-files=all
git -C '<repo>' diff --stat
git -C '<repo>' diff --cached --stat
```

先由人处理这些改动（提交、保留到别处或改用只读 `analysis` 模式），不要为了启动 Worker 自动丢弃用户文件。

### 2.2 `output directory already contains a run`

`--output-dir` 是一次运行的不可复用证据目录。发现既有 receipt 或 result 时，runtime 会拒绝覆盖，以免把两次运行的信任链和日志混在一起。

```powershell
Get-ChildItem '<output-dir>' -Force
```

为新任务使用新的目录；继续同一任务则运行 `continue_pi_worker.py`，不要删除旧 receipt 后伪装成新运行。

### 2.3 `model ... is not configured for provider ...`

provider 与 model 必须是 runtime 明确允许的组合。先查看 CLI 的当前选择，不要凭服务商宣传名猜模型 ID：

```powershell
python '.\scripts\start_pi_worker.py' --help
```

若需确认 provider 本身是否可用，应在不打印凭证的前提下做最小请求或启动一个无秘密的短分析任务。HTTP 兼容不等于事件流、reasoning、tool call 和 session continuation 全部兼容。

### 2.4 `pi executable not found on PATH`

后台 runner 找不到 Pi CLI：

```powershell
Get-Command pi -ErrorAction SilentlyContinue
pi --version
$env:PATH -split ';'
```

修复当前用户或启动 Codex 的进程环境后重新启动新任务。不要在 prompt 中传可执行文件路径或凭证作为临时绕过。

### 2.5 worktree 创建失败或路径过长

先检查 Git、仓库根和 worktree 登记：

```powershell
git --version
git -C '<repo>' rev-parse --show-toplevel
git -C '<repo>' worktree list --porcelain
git -C '<repo>' config --show-origin --get core.longpaths
```

runtime 默认把临时对象放在短根目录 `C:\piw`，并在自有目录清理时使用 Windows 扩展路径前缀。第三方构建工具仍可能不支持长路径，因此输出目录和仓库路径也应尽量短。

## 3. 等待、超时与 attention

### 3.1 watch 返回 `timeout`

`watch_pi_worker.py --timeout-seconds` 是“这次等待最多多久”，不是 Worker 的执行超时。watch 超时不会终止 Worker；可对同一个 receipt 再 watch 一次。

```powershell
python '.\scripts\watch_pi_worker.py' '<output-dir>\pi-receipt.json' --timeout-seconds 1800
```

不要改成每几秒读取日志或查询 PID。Windows watch 使用进程句柄和命名事件，终态或 attention 到来时由内核唤醒。

### 3.2 result 显示 `timedOut: true`、`timeoutMode: idle`

Worker 的 `--timeout-seconds` 是空闲超时：只有在一段时间没有重要活动事件时才终止进程树，不是从启动开始计算的绝对墙钟上限。长时间工具调用若不产生 Pi 事件，仍可能被判定为空闲。

排查：

```powershell
$result = Get-Content '<result-path>' -Raw -Encoding UTF8 | ConvertFrom-Json
$result | Select-Object timedOut,timeoutMode,elapsedSeconds,toolCalls,stopReason
Get-Content $result.evidence.stderr -Tail 100 -Encoding UTF8
```

确认任务确实需要更长的无输出窗口后，再在首次启动或 continuation 上提高 `--timeout-seconds`。不要用无限超时掩盖挂死工具。

### 3.3 `attention` 类别

runtime 会从 stderr 中识别并尽早发出一次 attention：

| 类别 | 常见原因 | 首要动作 |
| --- | --- | --- |
| `provider_auth` | HTTP 401/403、凭证失效或权限不足 | 在 provider 配置侧检查凭证；禁止把 Key 粘进 prompt 或 issue |
| `provider_rate_limit` | HTTP 429、额度或并发限制 | 降低并发、稍后重试或选择已配置的其他 route |
| `provider_unavailable` | HTTP 5xx、Bad Gateway、Gateway Timeout | 保留证据并重试；持续发生时切换 route |
| `transport_error` | DNS、连接重置、socket/网络超时 | 检查网络、代理与服务端状态 |
| `reasoning_ignored` | provider 不支持或忽略所选 thinking effort | 查看 `reasoningWarning`；改用兼容 route 或降低 thinking |
| `broken_pipe` | 子进程管道提前关闭 | 查看 runtime 与 Pi stderr，确认是否崩溃或被外部终止 |
| `output_oversize` | 单事件或累计证据超限 | 依据 result 的截断字段检查最终结果，缩小任务或分轮执行 |

attention 不是终态。处理后应继续 watch 同一 receipt；只有 `terminal` 事件或存在 result 才表示本轮结束。

### 3.4 `worker process is unavailable and has no result` / `worker exited without result`

说明 watch 无法打开 PID，且 receipt 指向的 result 不存在，或进程退出时 runner 没有完成原子写入。

```powershell
Get-Content '<output-dir>\runtime.stderr.log' -Tail 200 -Encoding UTF8
Get-Content '<output-dir>\runtime.stdout.log' -Tail 200 -Encoding UTF8
Get-ChildItem '<output-dir>' -Force
Get-ChildItem "$runtime\jobs" -Filter '*.json' | Select-Object FullName,LastWriteTime
```

下一次启动会运行 job reconciliation，把已死但有 result 的任务标记为 `pending_review`，无 result 的任务标记为 `orphaned`。孤儿任务仍需人工核对目录后处理，不能仅凭 PID 不存在就删除。

## 4. 输出、编码与日志

### 4.1 CP936/GBK 控制台乱码或 JSON 解析失败

Windows 控制台可能仍使用 CP936。runtime 的机器可读 stdout 通过 `ensure_ascii=True` 输出 ASCII JSON，文件统一写 UTF-8。调用方应优先读取 JSON 文件，并显式指定 UTF-8：

```powershell
Get-Content '<result-path>' -Raw -Encoding UTF8 | ConvertFrom-Json
python -X utf8 -c "import json; print(json.load(open(r'<result-path>', encoding='utf-8'))['status'])"
```

不要用控制台显示是否正常来判断文件编码是否正确；也不要把 `chcp 65001` 当成所有子进程编码问题的完整修复。

### 4.2 `evidenceTruncated: true`

历史上完整保存原始事件曾使单次日志膨胀到约 6.75 GB。当前 runtime 只保留必要事件，并设定硬上限：单条原始事件 8 MiB、事件日志 16 MiB、stderr 8 MiB、最终文本 1 MiB。超限会设置 `eventLogTruncated`、`stderrLogTruncated` 或 `oversizeEventCount`，并可能触发 `output_oversize` attention。

```powershell
$r = Get-Content '<result-path>' -Raw -Encoding UTF8 | ConvertFrom-Json
$r | Select-Object evidenceTruncated,eventLogTruncated,stderrLogTruncated,oversizeEventCount,evidenceLimits
Get-Item $r.evidence.events,$r.evidence.stderr | Select-Object FullName,Length
```

发生截断时不要宣称证据完整。优先缩小 prompt 的文件范围、把任务拆为多个 continuation，或让 Worker 把结论写到仓库内的明确交付文件，而不是要求回传海量源码/日志。

## 5. continuation 与 finalize 错误

### 5.1 `receipt predates Pi session continuation`

旧 receipt 没有 `sessionId`/`sessionDir`，无法安全恢复同一对话上下文。只能启动新 Worker，并在新 prompt 中提供必要的非秘密背景。

### 5.2 `worker is already finalized`

finalize 会删除自有 session，并可能删除 implementation worktree。settled receipt 不可继续，避免在已经清理的上下文上制造第二条历史。

### 5.3 continuation 被拒绝或并发分配

同一 owner receipt 一次只能有一个 active continuation。检查 owner 的 `latestReceiptPath`、`lastTurnIndex` 和 job 状态，不要同时启动两个修正轮次：

```powershell
$owner = Get-Content '<owner-receipt>' -Raw -Encoding UTF8 | ConvertFrom-Json
$owner | Select-Object status,cleanupStatus,lastTurnIndex,latestReceiptPath,sessionDir,worktreePath
```

### 5.4 finalize 拒绝清理

常见原因包括：result 尚不存在、implementation 的变更尚未集成却传了不匹配的决策、session/worktree 不在 receipt 声明的自有根目录，或目标是链接/junction。

正确顺序是：读取最新 result → 审查 diff/测试 → 必要时 continuation → 接受并集成，或明确拒绝 → finalize。`status=completed` 只表示执行结束，不是正确性证明。

```powershell
git -C '<worktree>' status --short
git -C '<worktree>' diff --stat
git -C '<worktree>' diff

python '.\scripts\finalize_pi_worker.py' '<owner-receipt>' --decision rejected
# 仅在变更已被应用或提交后：
python '.\scripts\finalize_pi_worker.py' '<owner-receipt>' --decision accepted --changes-integrated
```

## 6. 缓存问题

uv、pip 和 npm 使用共享缓存，合计软上限 20 GiB；只有没有 active Worker 时才允许 GC，超限后按旧文件优先删除到约 19 GiB。运行中的 marker 防止 GC 与依赖下载互相破坏。

```powershell
Get-Content "$runtime\cache-roots.json" -Raw -Encoding UTF8 | ConvertFrom-Json
Get-Content "$runtime\cache-status.json" -Raw -Encoding UTF8 | ConvertFrom-Json
Get-ChildItem "$runtime\active" -Force -ErrorAction SilentlyContinue
python '.\scripts\cache_gc.py' --runtime-root $runtime
```

不要手工并发删除共享缓存。即使缓存存在，Git worktree 本身也不会携带被忽略的 `node_modules`、`.venv`、构建产物或本地生成文件；Worker 仍可能需要安装/恢复依赖。

## 7. 安全边界与已知限制

### 7.1 Pi Worker 不是 Codex 原生子代理

这是由 Codex 调用脚本启动的外部 Pi executor。它不经过 Codex 原生 `spawn_agent` 的消息协议、状态树或工具治理；receipt/watch/continue/finalize 是本项目建立的生命周期协议。因而不能把“Pi Worker 完成”解释为“Codex 原生子代理已验证完成”。

### 7.2 guard 不是 OS sandbox

`pi_worker_guard.mjs` 会阻止明显的工作树外写入、危险递归删除、磁盘破坏命令，以及针对源 checkout/home 的变更或执行。但它是 tool-call 层的窄策略和启发式命令检查，不是完整 shell parser，也不是 Windows 权限边界、容器或操作系统沙箱。编码、间接脚本、未识别工具或子进程行为可能绕过字符串规则。

因此实现任务仍必须使用隔离 worktree、最小权限凭证和人工 review；不要把高价值秘密放进工作树或 prompt。

### 7.3 Windows watch 限制

事件 watch 当前只支持原生 Windows。它依赖 `OpenProcess`、`WaitForMultipleObjects` 和命名 Event；跨平台调用会直接拒绝。受 Windows 句柄上限影响，一次最多 watch 32 个带 attention 的 receipt。系统重启、会话边界或权限差异也可能使旧 PID/句柄不可用，此时以落盘 result 为准并执行 reconciliation。

### 7.4 receipt 是信任边界，不是签名凭证

continue 和 finalize 会信任 receipt 中的 `ownerReceiptPath`、`latestReceiptPath`、`sessionDir`、`worktreePath`、`sourceRoot` 等字段，再用“必须位于 runtime 自有根内”等检查缩小风险。receipt 没有数字签名；能够修改它的本地用户可能篡改生命周期元数据。输出目录应只授予可信本地用户写权限，且不要对来源不明的 receipt 运行 finalize。

### 7.5 provider 兼容性有限

不同 provider 对 Responses 风格输入、事件类型、tool call、reasoning effort、模型 ID 和 session continuation 的支持并不一致。普通文本请求成功不能证明 Pi 所需的完整事件协议兼容。runtime 只能检测部分 401/403/429/5xx、传输错误与 reasoning 被忽略；服务端语义偏差仍需人工核对 result。

### 7.6 worktree 不携带本地依赖

Git worktree 只检出版本控制中的内容，不复制 `node_modules`、`.venv`、本地 SDK、未跟踪配置、Git LFS 未拉取对象或外部服务状态。共享 cache 只减少重复下载，不等于存在可直接使用的安装目录。prompt 应给出仓库既有的依赖恢复和最小验证命令。

### 7.7 输出目录可能泄露源码或秘密

`changes.patch`、最终文本、stderr、工具名、路径和压缩事件都可能包含源码片段、内部目录名、命令参数或程序误打出的凭证。不要把 output directory 当成天然可公开的制品；上传 GitHub 前必须审查和脱敏。尤其不要把输出目录放进仓库后直接执行 `git add -A`。

### 7.8 `context-mode` 只按需启用

`--context-mode` 会加载额外 extension/skills，适合大日志、大文件或仓库级聚合；普通有界任务默认关闭，以减少依赖面、上下文重写和故障变量。启用时若包不完整会直接失败，而不是静默降级：

```powershell
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { "$HOME\.pi\agent" }
Test-Path "$agentDir\npm\node_modules\context-mode\build\adapters\pi\extension.js"
Test-Path "$agentDir\npm\node_modules\context-mode\skills"
```

## 8. 提交故障报告时的最小信息

可以提交：runtime/操作系统版本、脱敏后的启动参数、`status`/`stopReason`/截断字段、attention 类别、相关错误末尾、仓库是否干净、是否为 continuation，以及可复现的最小任务。

不要提交：任何 Key、完整 provider 配置、`~/.pi/agent/models.json`、Cookie、完整环境变量、未审查的 output directory、私有源码或包含敏感参数的原始命令行。
