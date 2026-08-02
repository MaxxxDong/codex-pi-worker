# Pi Worker 演进历史与设计取舍

本文记录当前 runtime 形成过程中遇到的主要问题、失败表现和修复方向。它不是逐提交 changelog；当前仓库在整理时尚无可追溯提交历史，因此以下按问题依赖关系组织。操作排查见 [errors-and-limitations.md](errors-and-limitations.md)。

## 1. 从“调用一个外部模型”到可审查 Worker

最初目标不是替换 Codex 主配置，而是让 Codex 把一个边界清楚的任务交给外部 Pi 执行。直接运行 CLI 可以得到文本，却缺少四个工程属性：

1. 启动后能立即拿到稳定句柄，而不是让调用方一直占着日志流。
2. 实现任务不能直接污染用户工作区。
3. 执行完成后必须由 Codex 审查，不能把进程退出等同于任务正确。
4. 出错、修正和清理需要延续同一个上下文和所有权链。

因此形成了四段式 lifecycle：

```text
start -> receipt -> watch -> terminal/attention
                         -> continue (同 session/worktree)
                         -> finalize (review 后结算)
```

这也是项目最重要的边界：Pi 是外部 Worker，Codex 是编排者和审查者。它不是 Codex 原生 `spawn_agent`，也不模拟原生 agent message 协议。

## 2. Windows 后台运行曾弹出终端窗口

### 问题

在 Windows 上，后台启动 Python、Git、Pi 或 GC 子进程时，如果沿用默认 creation flags，会短暂弹出控制台窗口。并行 Worker 越多，干扰越明显；用户还可能误以为需要操作那个窗口。

### 修复

后台进程使用 `CREATE_NO_WINDOW`，detached runner 使用独立进程组/后台标志；Git 状态查询、patch 生成和 GC 调度也统一隐藏窗口。stdout/stderr 不再依赖可见终端，而是写入 output directory。

### 结果与取舍

正常执行不再需要用户照看弹窗。代价是故障不会直接显示在交互窗口，所以 runtime 必须稳定产出 receipt、result 和独立日志。

## 3. 轮询状态和 tail 日志造成噪声

### 问题

早期等待方式倾向于反复查询 PID、检查 result 或 tail 日志。这会产生无意义 I/O 和重复状态消息，也容易出现“日志暂时没变化”被误判为挂死的问题。

### 修复

在 Windows 上改用两类内核对象：

- Worker 进程句柄表示本轮退出。
- `Local\pi-worker-attention-<run-id>` 命名 Event 表示需要提前介入。

`watch_pi_worker.py` 用 `WaitForMultipleObjects` 一次阻塞等待，先检查已经落盘的 terminal/attention，之后才等待事件。attention 文件交付后改名为 `pi-attention-delivered.json`，防止同一告警被重复消费。

### 结果与取舍

调用方只需一次 watch；watch 自身超时不会杀掉 Worker，可再次等待同一 receipt。当前实现依赖 Windows API，尚无 Linux/macOS 等价 watch。

## 4. 一次性任务无法低成本修正

### 问题

如果 Worker 的首轮实现接近正确但需要一个聚焦修正，重新创建任务会丢失模型 session，也可能重新创建 worktree、重新解释上下文并重复下载依赖。更糟的是，新旧输出之间没有明确所有权关系。

### 修复：session continuation

首轮启动创建稳定的 `sessionId` 和 runtime 自有 `sessionDir`。owner receipt 保存：

- `ownerReceiptPath`：生命周期根回执；
- `latestReceiptPath`：当前最新轮次；
- `lastTurnIndex`：已分配轮次；
- `sessionDir` 与 `sessionId`：Pi 会话；
- `worktreePath`：实现任务的同一隔离工作树。

`continue_pi_worker.py` 在 `turns/turn-NNN/` 创建新一轮输出，但复用同一 session 和 worktree。分配轮次时持有 runtime lock，避免两个 continuation 同时抢占 owner。

### 结果与取舍

修正 prompt 可以保持短小，只描述审查发现和验收要求。旧格式 receipt 因没有可信 session 元数据，不能续跑；runtime 会要求启动新 Worker，而不是猜测目录。

## 5. “completed” 曾容易被当成“已完成交付”

### 问题

模型返回最终文本、进程 exit code 为 0，只能证明执行路径结束，不能证明代码正确、测试真实通过、diff 可接受或变更已经进入目标分支。如果此时自动删除 worktree，审查证据也会丢失。

### 修复：review-gated finalize

每轮 result 都写入：

- `cleanupStatus: pending_review`；
- `reviewRequired: true`；
- `continuationAvailable: true`；
- `nextAction: review_then_continue_or_finalize`。

implementation run 还记录 base commit、变更文件、Git patch 和执行前后状态。只有调用方审查 diff 与测试后，才运行 `finalize_pi_worker.py`：

- `accepted --changes-integrated` 表示已接受且变更已经应用或提交；
- `rejected` 表示丢弃 Worker 工作；
- analysis run 同样要 finalize，以结算 session 与 job 状态。

finalize 会把 receipt/result 标记为 `settled`，再清理自有 worktree、session 和 run temp。

### 结果与取舍

临时目录会活到审查结束，占用一定磁盘；这是为了保留可复核证据。执行终态和交付终态被明确分开。

## 6. 并行 Worker 重复下载依赖并占满磁盘

### 问题

每个隔离 worktree 都可能触发 npm、pip 或 uv 下载。如果每轮使用独立缓存，网络和磁盘开销会随并发线性增长；若直接共享但没有活跃标记，GC 又可能删除正在使用的包。

### 修复：20 GiB 共享缓存

runtime 为 uv、pip 和 npm 建立共享 cache roots，并给每轮单独的临时目录。启动时写 active marker，结束时释放。GC 规则是：

- 三类缓存总量不超过 20 GiB 时不处理；
- 超限且没有 active Worker 时，按旧文件优先清理；
- 清到约 19 GiB，为下一轮留出回旋空间；
- 活跃 Worker 存在时跳过 GC；
- cache 状态和根路径写入 runtime JSON 供诊断。

### 结果与取舍

共享的是下载缓存，不是已安装环境。Git worktree 不会自动带上 `node_modules`、`.venv` 或被忽略的构建产物，因此恢复依赖仍是任务的一部分。

## 7. Windows 长路径与只读文件导致清理失败

### 问题

依赖树路径很深时，普通递归删除可能触发 `MAX_PATH` 问题；Git/object 或工具生成文件也可能是只读。更危险的是，为了“删干净”而对计算出的路径直接递归删除，可能越过 runtime 自有目录。

### 修复

Windows 默认 runtime root 缩短为 `C:\piw`。`remove_owned_tree`：

1. 先解析目标与 owned root；
2. 拒绝删除 owned root 本身或根外路径；
3. 拒绝 symlink/junction 目标；
4. Windows 删除时使用 `\\?\` 扩展路径；
5. 仅对目标树内的只读失败项改写权限后重试；
6. callback 若解析到树外立即拒绝。

### 结果与取舍

runtime 自有 worktree/session 的清理更稳定，但第三方工具内部仍可能不支持长路径。短 runtime root 是缓解，不是替所有工具开启长路径支持。

## 8. CP936 控制台破坏机器可读 JSON

### 问题

中文 Windows 的 stdout 可能使用 CP936/GBK。直接输出 UTF-8 中文 JSON 时，父进程读取可能乱码或抛编码错误；单独执行 `chcp 65001` 也不能保证所有子进程行为一致。

### 修复

机器可读 stdout 使用 `json.dumps(..., ensure_ascii=True)`，只输出 ASCII；receipt、result、attention 等文件统一以 UTF-8 原子写入。子进程文本捕获显式使用 UTF-8 并以 replacement 处理异常字节。

### 结果与取舍

终端 JSON 中的中文可能显示为 `\uXXXX`，但任何系统代码页都能安全传递；调用方解析后仍得到正常 Unicode。人工阅读应优先打开 UTF-8 文件。

## 9. 原始事件日志曾膨胀到约 6.75 GB

### 问题

Pi 事件中可能包含完整消息、推理内容、工具输出或超大单行。无上限地原样保存曾让一次运行生成约 6.75 GB 日志，拖慢磁盘、会话加载、备份与 Git 检查，并扩大源码/秘密泄露面。

### 修复

runtime 改为流式读取但只保存紧凑事件：

- tool start/end 只保留工具名和错误标记；
- assistant message 只保留最终文本、usage、provider/model 和 stop reason；
- agent end/settled 只保留类型；
- 其他事件忽略。

同时设置硬限制：单条原始事件 8 MiB、总事件日志 16 MiB、stderr 8 MiB、最终文本 1 MiB。result 明确记录截断状态和上限；超限触发 attention，而不是继续吞磁盘。

### 结果与取舍

日志变成“足以审查运行状态的证据”，不再是完整 replay。需要完整业务制品时应让 Worker 写入明确的仓库交付文件，而不是依赖事件日志。

## 10. 固定总时限误杀有进展的长任务

### 问题

从启动开始计算墙钟超时，会杀死持续有工具进展、但总耗时较长的构建或测试；完全没有超时则会留下真正挂死的进程。

### 修复：idle timeout

watchdog 只统计重要活动：tool start/end、assistant message end 和 agent end。每次活动都会刷新 deadline；连续无活动超过 `--timeout-seconds` 才终止进程树。result 记录 `timedOut` 和 `timeoutMode: idle`。

### 结果与取舍

有事件流的长任务可以继续运行。一个本身长时间静默的外部命令仍可能被误判为空闲，因此超时值应按任务调整，而不是无限放宽。

## 11. provider 故障只能等到终态才看见

### 问题

鉴权失败、限流、服务端 5xx、网络错误或 reasoning 参数被忽略时，如果只等进程结束，调用方可能浪费整个等待窗口，也不知道应该重试、切 route 还是修改配置。

### 修复：provider attention

runtime 流式读取 stderr 并分类：`provider_auth`、`provider_rate_limit`、`provider_unavailable`、`transport_error`、`reasoning_ignored`、`broken_pipe` 和输出超限。每轮最多发一次 attention，原子写文件后设置 Windows 命名 Event，使 watch 立即返回。

### 结果与取舍

调用方可以提前处理明显的 provider 问题，再继续等待终态。分类依赖有限正则，只是运维提示，不是完整服务端错误模型；未知错误仍需查看 stderr 和 result。

## 12. 外部 Worker 获得 shell 后的危险删除风险

### 问题

implementation 需要文件写入和命令执行能力，但模型可能生成递归删除、磁盘命令，或从 worktree 通过绝对路径/`..` 修改源 checkout 与用户目录。仅靠 prompt 约束不够。

### 修复：两层边界

第一层是 Git detached worktree：源 checkout 必须干净，实际写入发生在 runtime 自有工作树。第二层是 `pi_worker_guard.mjs`：

- write/edit/AST replacement 只能落在 execution cwd 内；
- 拦截无法证明目标是 worktree 内单一 literal path 的递归删除；
- 拦截 format、diskpart、Clear-Disk、Initialize-Disk、VSS 删除等明显磁盘破坏；
- 对包含外部绝对路径或 `..` 的变更/执行命令进行阻断；
- 允许只读查看 source/home，但阻止针对它们的变更或执行。

清理端再用 receipt 所有权、owned-root、symlink/junction 和长路径检查保护 finalize。

### 结果与取舍

明显误操作更难发生，但 guard 是启发式 tool-call policy，不是 OS sandbox 或完整 shell parser。高风险仓库仍应依靠操作系统隔离、最小权限和无秘密工作区。

## 13. context-mode 从默认加载改为按需

### 问题

对每个小任务都加载 context-mode 会增加 extension/skill 依赖、启动故障点和上下文变换；包缺失或不完整时，简单任务也会失败。

### 修复

默认不开启。只有大日志、大文件或仓库级聚合明确需要时传 `--context-mode`。启用后 runtime 验证 extension 和 skills 目录完整，缺失则显式失败，不做隐藏 fallback。continuation 继承首轮选择，保证同一 session 行为一致。

### 结果与取舍

普通有界任务路径更短；大上下文任务仍可主动启用。context-mode 不是性能开关，也不应被当作 provider 兼容问题的修复手段。

## 14. 当前仍然存在的边界

这些限制是设计现实，不应在文档或产品描述中隐去：

- Pi 是外部 executor，不是 Codex 原生 `spawn_agent` 子代理；生命周期和可见性由本项目脚本提供。
- guard 不是 OS sandbox；它无法证明任意 shell 字符串或子进程绝对安全。
- event watch 目前仅支持原生 Windows，且一次最多等待 32 个带 attention 的 receipt。
- receipt 没有签名，是本地信任边界；被篡改的 receipt 不应拿去 continue/finalize。
- provider 即使支持普通文本接口，也可能不支持 Pi 所需事件、工具、reasoning 或 continuation 语义。
- detached worktree 不携带 `node_modules`、`.venv`、未跟踪配置和其他本地依赖；共享 cache 只减少下载。
- output directory 可能含 patch、源码、内部路径、命令参数或程序误输出的秘密，发布前必须审查脱敏。
- 紧凑日志是有上限的诊断证据，不保证完整重放；截断时必须在结论中说明。

这些边界共同解释了为什么 Codex 必须保留最终审查责任，也解释了为什么 `finalize` 被设计成显式、review-gated 的最后一步。
