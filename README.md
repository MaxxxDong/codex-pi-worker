# Codex Pi Worker

面向 Windows Codex 的 Pi 子代理编排器。Codex 负责拆任务、审核和最终验收；Pi 在后台完成有边界的分析、实现、修复、代码搜索或联网研究。

它不是 Codex 原生 `spawn_agent` 的替代实现，也不会更换 Codex 主模型。它是一套独立的 Skill + lifecycle runtime，重点解决后台执行、完成即通知、同会话续跑、并行 Worker、审核后清理和可审计结果。

## 核心能力

| 能力 | 行为 |
|---|---|
| 后台启动 | `start` 立即返回 receipt，Windows 使用无窗口 detached process |
| 事件优先等待 | named event + 进程句柄唤醒，不需要反复 `status`/日志轮询 |
| 分析与实现分流 | `analysis` 禁止写工具；`implementation` 使用独立 Git worktree |
| 同任务续跑 | receipt 绑定 Pi session、worktree 和 turn 序号 |
| 审核后清理 | Worker 结束只进入 `pending_review`；Codex 接受或拒绝后显式 finalize |
| 并行执行 | 独立任务可共享 20 GiB 依赖下载缓存，写入范围不能重叠 |
| 失败早通知 | 401/403、429、5xx、EPIPE、传输错误、reasoning 降级会发 `attention` |
| Windows 兼容 | UTF-8/CP936 安全 JSON、`CREATE_NO_WINDOW`、进程树终止、长路径清理 |
| 证据控制 | JSON result、紧凑事件、stderr、binary patch 与日志容量上限 |

## 快速开始

要求 Windows、Python 3.12+、Node.js 22.19+、Git，以及 Pi CLI 0.83+。完整安装和私有 provider 配置见 [安装指南](docs/installation.md) 与 [配置指南](docs/configuration.md)。

```powershell
npm install -g @earendil-works/pi-coding-agent@0.83.0
git clone https://github.com/MaxxxDong/codex-pi-worker C:\CodexWS\Software\codex-pi-worker
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.codex\skills\pi-worker" `
  -Target "C:\CodexWS\Software\codex-pi-worker"
```

启动一个只读分析 Worker：

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\start_pi_worker.py" `
  --cwd C:\path\to\repo `
  --prompt-file C:\path\to\task.md `
  --mode analysis `
  --output-dir C:\path\to\evidence
```

然后只等待一次，不做轮询：

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\watch_pi_worker.py" `
  C:\path\to\evidence\pi-receipt.json `
  --timeout-seconds 1800
```

完整的 continuation、review 和 finalize 命令见 [运行与产物](docs/operations.md)。

## 文档

- [架构与生命周期](docs/architecture.md)
- [安装指南](docs/installation.md)
- [Provider、模型与扩展配置](docs/configuration.md)
- [运行、产物、通知和清理](docs/operations.md)
- [安全边界](docs/security.md)
- [错误与已知限制](docs/errors-and-limitations.md)
- [历史问题与修复记录](docs/history.md)
- [发布记录](docs/releases/release-notes.md)

## 重要边界

- `status=completed` 只代表执行合同成立，不代表代码正确。
- implementation 使用独立 worktree 和命令 guard，但不是 OS 级沙箱；不要执行不可信 prompt。
- `~/.pi/agent/models.json`、receipt、session、patch 和日志可能含秘密或私有源码，禁止提交。
- 清理必须发生在 Codex 审核之后；不要让 Worker 自己删除候选 worktree。

## 最新更新

### 2026-08-02

- 首次公开 Windows lifecycle runtime：事件通知、session continuation、review-gated cleanup、共享缓存、长路径与日志上限。
- 发布前加固缓存所有权、成果删除门禁、结构化失败和 shell 路径逃逸检查。

完整记录见 [发布记录](docs/releases/release-notes.md)。

## License

[MIT](LICENSE)
