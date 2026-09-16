# 运行、产物、通知和清理

> 说明：本文档主要面向 Windows 平台的 Python 运行时操作；macOS 平台的 Subworker (v0.3.1) 多执行器操作与命令请参考 [macOS 安装与指南](macos.md) 与 [macOS SKILL.md](../macos/SKILL.md)。

## 一轮标准流程

Windows 统一入口为 `python scripts/subworker.py`，提供 dispatch、wait、continue、steer、cancel、cleanup、diagnose、profiles；旧脚本仍可直接调用。
默认读取当前 Pi 的 provider/model/thinking，显式参数优先。默认完整原生权限、环境与工具（含 PowerShell 和扩展工具），不加载额外 guard，Skills/扩展/模板正常发现；`--guarded` 才启用原限制。
新增 `--mode in-place` 可直接在指定目录写入（包括非 Git）；analysis 仅通过任务指令约定只读。
派发 `--timeout-seconds` 默认0，显式正数才启用 idle 硬超时；`--startup-attention 60 --silent-reminder 600 --progress-reminder 600` 为软提醒（analysis progress 默认0），不会终止任务。

### 1. 写任务文件

任务应包含目标、允许范围、交付物和聚焦检查。不要写 Key、token、cookie 或私有配置内容。路径不确定时让 Worker 先用 `find`/`grep` 定位，不要根据符号名或目录惯例猜测文件路径。

### 2. 启动

```powershell
python scripts\start_pi_worker.py `
  --cwd C:\absolute\repo `
  --prompt-file C:\absolute\task.md `
  --mode implementation `
  --output-dir C:\absolute\evidence
```

普通任务默认是 `implementation`，可省略 `--mode implementation`。只有明确只读任务才使用 `--mode analysis`；两种模式都有 `read/grep/find/ls` 和联网搜索。按任务增加能力：

implementation 会把源仓库当前的 staged、unstaged 和非 ignored untracked WIP 复制到隔离 worktree，并在隔离区建立临时 baseline；不会 stash、add、commit 或改写源仓库。最终 `changes.patch` 只包含 Worker 相对这份 WIP 的增量。冲突、dirty submodule、越界链接和快照期间并发变化会明确拒绝。

需要固定外部证据副本时，可显式复制输入（guarded 模式下必须通过副本执行处理）：

```powershell
python scripts\start_pi_worker.py ... `
  --evidence-file C:\absolute\analysis-a\pi-result.json `
  --evidence-file C:\absolute\analysis-b\pi-result.json
```

副本和路径映射位于 worktree 的 `.pi-worker-inputs/`，属于 baseline，不会进入 Worker patch。

```powershell
# Firecrawl MCP，可用于只读或实现任务
python scripts\start_pi_worker.py ... --mode analysis --firecrawl

# Playwright 仅用于浏览器 implementation 任务
python scripts\start_pi_worker.py ... --playwright

# 大日志/全仓聚合才启用
python scripts\start_pi_worker.py ... --context-mode
```

这些开关会写入 receipt，并由同一任务的 continuation 自动继承。

启动返回 `pi-receipt.json`，其中记录 run、PID、session、worktree、provider/model、result 和后续动作。每轮必须使用唯一 output directory。

### 3. 等待一次

```powershell
python scripts\watch_pi_worker.py C:\absolute\evidence\pi-receipt.json --timeout-seconds 1800
```

不要用循环 `status`、日志 tail 或 10/30 秒轮询代替。watch 默认返回紧凑结果，`--full` 保留完整 result；`--consumer` 默认使用 CODEX_THREAD_ID，不同对话独立确认提醒。`diagnose <receipt>` 可按需只读查看进展和重试建议。watch 会返回：

- `attention`：运行中出现 provider/runtime 问题；审查证据后可继续等待同一 receipt。
- `terminal`：`pi-result.json` 已存在；进入 Codex 审核。
- `timeout`：watch 自己的等待窗口结束，不等于 Worker 已失败。

同一 Codex 任务并行启动多个 Worker 时，把全部存活 receipt 传给一个 watch：

```powershell
python scripts\watch_pi_worker.py `
  C:\evidence\worker-a\pi-receipt.json `
  C:\evidence\worker-b\pi-receipt.json `
  C:\evidence\worker-c\pi-receipt.json `
  --timeout-seconds 1800
```

watch 在任意一个 receipt 首次出现 `attention`、`terminal` 或 `orphaned` 时立即返回，不等待其他 Worker。处理该事件后，terminal receipt 从下一次 watch 中移除；attention receipt 处理后继续保留。不同 Codex 对话各自保持自己的 watch，不要让两个对话消费同一个 receipt，否则其中一个可能先取走 attention 文件。一个 watch 最多接收 32 个带 attention 的 receipt；更多任务应按所有权拆成多组。

### 4. 运行中 steer

Worker 仍在运行时，可通过 Pi 原生 RPC 在当前工具调用完成后、下一次模型调用前插入纠偏：

```powershell
python scripts\steer_pi_worker.py `
  C:\absolute\evidence\pi-receipt.json `
  --message-file C:\absolute\correction.md
```

命令只接受当前 latest receipt，等待 Pi 返回 accepted 回执，不记录消息正文。收到回执后继续 watch 同一 owner receipt。当前跨进程投递使用 Windows named event；若本轮已 terminal，应改用 continuation。

### 5. 主动取消

```powershell
python scripts\cancel_pi_worker.py C:\absolute\evidence\pi-receipt.json
```

取消请求只作用于 receipt 当前拥有的 run。runner 自己终止 Pi 进程树并写 `status=cancelled`，worktree、session 和 result 保留给 Codex 审核；随后继续 watch，审核后再 finalize。不要直接按 receipt PID 执行 `taskkill`。

### 6. 同任务续跑

```powershell
python scripts\continue_pi_worker.py `
  C:\absolute\evidence\pi-receipt.json `
  --prompt-file C:\absolute\correction.md
```

continuation 复用同一 session 和 implementation worktree，证据写入 `turns\turn-NNN`。并发申请同一 owner receipt 的下一 turn 会被 runtime lock 拒绝。

### 7. 审核后 finalize

接受且已把改动应用/提交到正式工作树：

```powershell
python scripts\finalize_pi_worker.py `
  C:\absolute\evidence\pi-receipt.json `
  --decision accepted `
  --changes-integrated
```

拒绝候选：

```powershell
python scripts\finalize_pi_worker.py `
  C:\absolute\evidence\pi-receipt.json `
  --decision rejected
```

`--changes-integrated` 是 Codex 的显式审核声明，不由 Worker 自己设置。finalize 删除 runtime 自有 worktree、session 和 run temp，将 result 的 `reviewRequired`、`continuationAvailable` 设为 `false`，并保留用户指定 output directory 作为证据；确认不再需要后由用户按项目策略清理 evidence。

## 产物

| 文件 | 内容 |
|---|---|
| `pi-receipt.json` | 生命周期所有权、PID、路径、provider/model、next action |
| `pi-result.json` | 状态、usage、工具、最终文本、patch、清理状态 |
| `pi-events.jsonl` | 压缩后的工具/消息/结束事件，带容量上限 |
| `pi-stderr.log` | 脱敏并限长的 Pi stderr |
| `runtime.*.log` | detached runner 自身 stdout/stderr |
| `changes.patch` | implementation 相对 base commit 的 binary patch |
| `pi-attention*.json` | 按序号保存的运行中错误通知及已投递证据 |

这些文件可能含源码、绝对路径和模型输出，不应上传公共 issue 或仓库。

receipt 是启动和所有权凭据，不是生命周期真相源；其中早期的 `status=running` 只是启动快照。以 watch 返回的 `lifecycleState` 和 runtime job 为准，持续态只有 `starting`、`running`、`pending_review`、`settled`，异常进程为 `orphaned`；`attention` 是事件，`cancelled` 是 result 的执行结果。

## 成功判定

runtime 只有同时满足以下条件才写 `status=completed`：

- Pi 进程 exit 0；
- 未 idle timeout；
- 收到 `agent_end`；
- 返回 provider/model 与请求一致；
- `stopReason == stop`；
- 未检测到 reasoning 降级。

这仍不是代码正确性的证明。Codex 必须检查 patch、最终文本、工具错误和独立测试。

## 缓存

默认共享缓存属于 runtime：`C:\piw\cache\{uv,pip,npm}`。所有 Worker 共用下载结果，run-local temp 在每轮结束后删除。没有 active Worker 且总量超过 20 GiB 时，GC 按最旧文件修剪到 19 GiB；显式环境覆盖意味着用户自行承担该目录的所有权和并发风险。
