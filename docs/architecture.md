# 架构与生命周期

## 角色边界

Codex 是调度者和最终责任方：编写任务、选择模式、等待事件、审查 patch、运行独立验证并决定接受或拒绝。Pi 或 Agy 是最内层执行器：在给定 cwd、模型和可选 timeout 内完成一轮任务。

本项目不修改 Codex 主模型，也不使用 Codex Multi-Agent V2 的 `agent_message` 协议。任务以普通 prompt 进入 Pi 或 Agy CLI，因此第三方 Responses provider 是否支持 Codex 专用输入类型，与本 Worker 是两个独立问题。

macOS 的执行器边界保持很小：Pi 适配器负责 profile、capability、session 和 JSON/RPC；Agy 适配器负责 CLI 参数、stream-json、`conversation_id` 和 usage。worktree、状态、事件等待、取消、patch 与清理全部共享，新增执行器不得复制这些生命周期能力。

## 组件

| 文件 | 职责 |
|---|---|
| `SKILL.md` | Codex 可见的最短操作协议 |
| `start_pi_worker.py` | 校验、worktree/session 分配、receipt 先提交、后台启动 |
| `run_pi_worker.py` | 调用 Pi、压缩事件、idle watchdog、attention、result 和 patch |
| `watch_pi_worker.py` | Windows named event/进程句柄等待 |
| `continue_pi_worker.py` | 在 receipt 所有的 session/worktree 中续跑下一 turn |
| `finalize_pi_worker.py` | 审核后删除 worktree/session 并写入 settled 决策 |
| `runtime_support.py` | 原子 JSON、锁、PID、缓存、job reconciliation、长路径清理 |
| `pi_worker_guard.mjs` | Pi tool-call 策略防护；不是 OS sandbox |
| `steer_pi_worker.py` | receipt 绑定的 Windows named-event RPC steer 客户端 |
| `cache_gc.py` | Worker 空闲时将自有共享缓存从 20 GiB 修剪到 19 GiB |

## 数据流

```text
Codex prompt file
      |
      v
start -> validate -> reserve cache -> optional detached worktree
      -> create session/job -> spawn gated runner
      -> atomically write receipt -> release launch gate
                                  |
                                  v
                           Pi --mode rpc
                                  |
               +------------------+------------------+
               |                    |                        |
          compact events      steer named event         stderr classifier
               |                    |                        |
       token/tool/final text    RPC stdin queue       attention named event
               |                                     |
               +------------------+------------------+
                                  v
                           pi-result.json
                                  |
                         watch returns terminal
                                  |
                  Codex review / verify / integrate
                         |                    |
                      continue             finalize
                                              |
                                      settled + cleanup
```

## 状态机

```text
starting -> running -> pending_review -> settled
                    \-> orphaned
```

- `starting`：job 已登记，runner 尚未通过 receipt launch gate。
- `running`：receipt 已原子落盘，后台 PID 和 active marker 已登记。
- `pending_review`：runner 已终态，结果和证据可审查；worktree/session 必须保留。
- `settled`：Codex 已接受或拒绝，受控临时资源已删除。
- `orphaned`：进程消失且没有可信 result，需要人工审计；reconcile 不会自动删除证据。

## 为什么 receipt 先于执行

后台进程先启动、receipt 后写入会产生不可追踪的孤儿任务。当前实现让 runner 阻塞在单字节 launch gate；只有 receipt、job 和 cache marker 都原子提交后才放行。任一步失败都会终止进程树并回滚本轮自有资源。

## 分析与实现模式

- `analysis`：直接在源 cwd 运行，但排除 `bash/edit/write/ast_grep_replace`，适合审查、搜索和研究。
- `implementation`：要求源 checkout 干净，从当前 HEAD 创建 detached worktree。Pi 的直接写工具只能指向执行 worktree；shell guard 拦截已知路径逃逸和破坏模式。

implementation 的隔离是工程防护，不是安全边界。模型仍在用户权限下运行，不能用于不可信代码或恶意 prompt。

## 并发模型

每个 run 有独立 UUID、session、output 和可选 worktree。runtime lock 只保护 job、turn 分配和 cache marker 等短临界区；多个独立 Worker 可并行。不要让两个 implementation Worker 修改同一逻辑范围，最终昂贵的全仓检查应在 Codex 集成后只跑一次。
