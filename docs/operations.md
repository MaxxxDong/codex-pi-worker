# 运行、产物、通知和清理

## 一轮标准流程

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

不要用循环 `status`、日志 tail 或 10/30 秒轮询代替。watch 会返回：

- `attention`：运行中出现 provider/runtime 问题；审查证据后可继续等待同一 receipt。
- `terminal`：`pi-result.json` 已存在；进入 Codex 审核。
- `timeout`：watch 自己的等待窗口结束，不等于 Worker 已失败。

最多可在一次 watch 中传入 32 个带 attention 的 receipt。

### 4. 运行中 steer

Worker 仍在运行时，可通过 Pi 原生 RPC 在当前工具调用完成后、下一次模型调用前插入纠偏：

```powershell
python scripts\steer_pi_worker.py `
  C:\absolute\evidence\pi-receipt.json `
  --message-file C:\absolute\correction.md
```

命令只接受当前 latest receipt，等待 Pi 返回 accepted 回执，不记录消息正文。收到回执后继续 watch 同一 owner receipt。当前跨进程投递使用 Windows named event；若本轮已 terminal，应改用 continuation。

### 5. 同任务续跑

```powershell
python scripts\continue_pi_worker.py `
  C:\absolute\evidence\pi-receipt.json `
  --prompt-file C:\absolute\correction.md
```

continuation 复用同一 session 和 implementation worktree，证据写入 `turns\turn-NNN`。并发申请同一 owner receipt 的下一 turn 会被 runtime lock 拒绝。

### 6. 审核后 finalize

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
