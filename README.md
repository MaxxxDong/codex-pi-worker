# Codex Pi Worker

面向 Windows 与 macOS Codex 的 Pi 子代理编排器。Codex 负责拆任务、审核和最终验收；Pi 在后台完成有边界的分析、实现、修复、代码搜索或联网研究。

它不是 Codex 原生 `spawn_agent` 的替代实现，也不会更换 Codex 主模型。它是一套独立的 Skill + lifecycle runtime，重点解决后台执行、完成即通知、同会话续跑、并行 Worker、审核后清理和可审计结果。

## 核心能力

| 能力 | 行为 |
|---|---|
| 后台启动 | `start` 立即返回 receipt，Windows 使用无窗口 detached process |
| 事件优先等待 | named event + 进程句柄唤醒，不需要反复 `status`/日志轮询 |
| 分析与实现分流 | 默认 `implementation`；只有明确只读任务才用 `analysis`，两者都有 `grep/find/ls` |
| 同任务续跑 | receipt 绑定 Pi session、worktree 和 turn 序号 |
| 运行中纠偏 | Pi 原生 RPC `steer`，receipt 绑定投递并等待 accepted 回执 |
| 审核后清理 | Worker 结束只进入 `pending_review`；Codex 接受或拒绝后显式 finalize |
| 并行执行 | 独立任务可共享 20 GiB 依赖下载缓存，写入范围不能重叠 |
| 失败早通知 | provider/runtime 错误、连续工具失败和重试失败会立即发可重复 `attention` |
| Windows 兼容 | UTF-8/CP936 安全 JSON、`CREATE_NO_WINDOW`、进程树终止、长路径清理 |
| macOS 原生链路 | JSON headless、POSIX 事件唤醒、轻量 worktree、审核后清理和共享缓存 LRU |
| 证据控制 | JSON result、紧凑事件、stderr、binary patch 与日志容量上限 |

## 快速开始

Windows 要求 Python 3.12+、Node.js 22.19+、Git 和 Pi CLI 0.83+。macOS 使用 Node.js、Git 和 Pi CLI 0.83+，不依赖 Python。完整安装和私有 provider 配置见 [Windows 安装指南](docs/installation.md)、[macOS 安装指南](docs/macos.md) 与 [配置指南](docs/configuration.md)。

```powershell
npm install -g @earendil-works/pi-coding-agent@0.83.0
git clone https://github.com/MaxxxDong/codex-pi-worker C:\CodexWS\Software\codex-pi-worker
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.codex\skills\pi-worker" `
  -Target "C:\CodexWS\Software\codex-pi-worker"
```

启动一个普通实现 Worker（默认模式，无需写 `--mode implementation`）：

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\start_pi_worker.py" `
  --cwd C:\path\to\repo `
  --prompt-file C:\path\to\task.md `
  --output-dir C:\path\to\evidence
```

然后只等待一次，不做轮询：

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\watch_pi_worker.py" `
  C:\path\to\evidence\pi-receipt.json `
  --timeout-seconds 1800
```

完整的 continuation、review 和 finalize 命令见 [运行与产物](docs/operations.md)。

macOS 将仓库内 `macos/` 作为唯一 Skill 入口：

```bash
git clone https://github.com/MaxxxDong/codex-pi-worker.git ~/codex-pi-worker
ln -s "$HOME/codex-pi-worker/macos" "$HOME/.codex/skills/pi-worker"
$HOME/.codex/skills/pi-worker/bin/pi-worker profiles
```

已有同名目录时先按 [macOS 安装指南](docs/macos.md) 迁移，不要覆盖用户文件。

## 文档

- [架构与生命周期](docs/architecture.md)
- [安装指南](docs/installation.md)
- [macOS 安装指南](docs/macos.md)
- [Provider、模型与扩展配置](docs/configuration.md)
- [运行、产物、通知和清理](docs/operations.md)
- [安全边界](docs/security.md)
- [错误与已知限制](docs/errors-and-limitations.md)
- [历史问题与修复记录](docs/history.md)
- [发布记录](docs/releases/release-notes.md)

## 重要边界

- `status=completed` 只代表执行合同成立，不代表代码正确。
- implementation 使用独立 worktree 和命令 guard，但不是 OS 级沙箱；不要执行不可信 prompt。
- Firecrawl 通过 `--firecrawl` 按需加载；Playwright 通过 `--playwright` 仅在浏览器任务加载。
- `~/.pi/agent/models.json`、receipt、session、patch 和日志可能含秘密或私有源码，禁止提交。
- 清理必须发生在 Codex 审核之后；不要让 Worker 自己删除候选 worktree。

## 最新更新

### 2026-08-09

- macOS v0.1.6 验证 Pi 0.84.1，Headless Worker 改用原生 `--offline` 跳过启动期联网检查，同时保留实际 provider 请求。
- 兼容 Pi 0.84 的纯增量 `message_update`；终态继续只依赖完整 `message_end` 与 `agent_settled`。
- 建议将 Context7、Lens、Context Mode、Playwright 保留安装但过滤默认资源，由 Worker capability 按需显式加载。

### 2026-08-05

- macOS v0.1.5 移除不再使用的 EdgeFN provider 与 Worker profile，保留 DeepSeek 官方路由。

### 2026-08-04

- macOS v0.1.4 增加 DeepSeek 官方与 EdgeFN 0731 的同条件 Pi Worker profile，统一使用 High/Max 推理档位。
- macOS v0.1.3 的批量 `wait` 在任一 Worker 完成、失败或异常时立即返回 `results/alerts/pending`，不再等待最慢任务；多个对话也可独立等待同一 run。
- macOS v0.1.2 用单一轻量状态机明确 `starting/running/stopping/finalizing/terminal`，活动与进程存活信息保持独立，不扩展到业务任务或 Codex 线程判断。
- 新增 supervisor 管理的取消命令；`status`/`wait` 能批量收口 supervisor 异常消失的运行，事件等待的本地兜底缩短到 15 秒。
- 工具活动与续跑历史改为有界紧凑摘要，保留诊断所需的 reason、attention、模型和 usage，不保存工具参数或重复调用明细。
- macOS 默认保留普通用户 Skill，但将 Context7、Lens、Context Mode、Playwright 的 Skill 与 extension/MCP 一起改为 capability 按需加载；相同任务实测减少约 15% 输入 Token。
- 删除 macOS 旧 `meta.json/event.json` 兼容扫描，新版只维护当前 result 生命周期。
- 加入经过真实调用验证的 macOS JSON headless runtime，read 模式不再暴露 `edit/write`。
- 整次运行聚合模型调用、cache read 与 reasoning usage；attention/failure 返回 `pending` 以便立即续接事件等待。
- 共享缓存采用 90 天优先的 LRU 和 20 GiB 上限，不使用整库 purge；候选只在 Codex 明确审核后清理。

### 2026-08-03

- 切换为 Pi 原生 RPC，支持运行中 steer、accepted 回执和多次异常 attention。
- 连续工具失败、自动重试失败、扩展/压缩错误会提前唤醒；RPC 退出会排空 stdout，避免 Windows EPIPE。
- finalize 后会同步关闭 `reviewRequired` 与 `continuationAvailable`，避免已清理任务仍被误判为可审核或可续跑。
- Worker 对不确定路径先执行 `find`/`grep`，减少根据 Kotlin/Java 符号名猜错文件路径的无效调用。

完整记录见 [发布记录](docs/releases/release-notes.md)。

## License

[MIT](LICENSE)
