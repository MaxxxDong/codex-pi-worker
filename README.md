# Subworker

面向 Windows 与 macOS 多宿主 IDE（如 Codex 等）的通用后台子代理编排器。宿主负责拆任务、审核和最终验收；macOS 当前在统一的生命周期与工作区治理下接入 Pi、Agy、Claude Code、Grok Build 四个执行器完成分析、实现、修复、代码搜索或联网研究。

它不是宿主原生 `spawn_agent` 的替代实现，也不会更换宿主主模型。它是一套独立的 Skill + lifecycle runtime；执行器只是可替换的最内层适配器，worktree、事件通知、续跑、并行、审核后清理和结果合同只维护一份。

## 核心能力

| 能力 | 行为 |
|---|---|
| 后台启动 | `dispatch`/`start` 立即返回 receipt，Windows 使用无窗口 detached process，macOS 使用守护 supervisor |
| 事件优先等待 | POSIX/Windows 命名事件与进程句柄唤醒，不需要反复 `status`/日志轮询 |
| 多执行器边界 | 支持 Pi（默认，带完整 RPC/steer/capability）、Agy（原生 stream-json/effort，无 5 分钟限制）、Claude Code（原生 stream-json，支持 CommandCode 与 native） |
| 分析与实现分流 | 默认 `write`/`implementation`；只有明确只读任务才用 `read`/`analysis`，两者都有 `grep/find/ls` |
| 工作目录 | Windows/macOS 均支持脏基线 worktree 与 in-place；Windows analysis 默认以提示约束只读，工具不裁剪 |
| 同任务续跑 | 统一凭据绑定会话、worktree 和 turn 序号，支持跨轮次 `continue` |
| 运行中纠偏 | Pi 原生 RPC `steer`，receipt 绑定投递并等待 accepted 回执（Agy/Claude 续跑使用 `continue`） |
| 审核后清理 | Worker 结束只进入 `pending_review`；宿主接受或拒绝后显式 `cleanup`/`finalize` |
| 并行执行 | 独立任务可共享 20 GiB 依赖下载缓存，写入范围不能重叠 |
| 失败早通知 | provider/runtime 错误、连续工具失败和重试失败会立即发可重复 `attention`；启动静默软提醒不杀任务 |
| 证据控制 | JSON result、紧凑事件、stderr、binary patch 与日志容量上限 |

## 快速开始

Windows 要求 Python 3.12+、Node.js 22.19+、Git 和 Pi CLI 0.83+。macOS（v0.4.0）使用 Node.js、Git 和 Pi CLI 0.83+；Agy 后端另需 Agy CLI 1.1.8+，Claude 后端另需 Claude Code 2.1.252+。仓库当前仍托管于 [MaxxxDong/codex-pi-worker](https://github.com/MaxxxDong/codex-pi-worker)。完整安装和私有 provider 配置见 [Windows 安装指南](docs/installation.md)、[macOS 安装指南](docs/macos.md) 与 [配置指南](docs/configuration.md)。

### Windows 安装与运行

```powershell
npm install -g @earendil-works/pi-coding-agent@0.85.1
git clone --branch agent/pi-worker-capabilities https://github.com/MaxxxDong/codex-pi-worker C:\CodexWS\Software\codex-pi-worker
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.codex\skills\pi-worker" `
  -Target "C:\CodexWS\Software\codex-pi-worker"
```

启动一个普通实现 Worker（默认模式，无需写 `--mode implementation`）：

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\subworker.py" dispatch `
  --cwd C:\path\to\repo `
  --prompt-file C:\path\to\task.md `
  --output-dir C:\path\to\evidence
```

然后只等待一次，不做轮询：

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\subworker.py" wait `
  C:\path\to\evidence\pi-receipt.json `
  --timeout-seconds 1800
```

完整的 continuation、review 和 finalize 命令见 [运行与产物](docs/operations.md)。

### macOS 安装与运行 (v0.4.0)

macOS 将仓库内 `macos/` 目录作为标准 Skill 入口，统一执行入口为 `macos/bin/subworker`（正式安装计划在 `~/.codex/skills/subworker`，可供任何宿主 IDE 通过同一命令调用）：

```bash
git clone https://github.com/MaxxxDong/codex-pi-worker.git ~/codex-pi-worker
mkdir -p "$HOME/.codex/skills"
ln -s "$HOME/codex-pi-worker/macos" "$HOME/.codex/skills/subworker"
$HOME/.codex/skills/subworker/bin/subworker profiles
```

> **兼容性说明**：
> 1. 持久存储物理路径暂保留在 `pi-worker/runs` 目录下，确保升级后旧任务、已有 worktree 及 session 继续可被发现与清理。
> 2. 规范公开环境变量统一为 `SUBWORKER_*`（例如 `SUBWORKER_NODE_BIN`、`SUBWORKER_PI_BIN`、`SUBWORKER_STATE_ROOT`）；旧 `PI_WORKER_*` 作为兼容输入保留。Pi 本身的 `PI_CODING_AGENT_DIR` 等变量不受影响。
> 3. 启动器（launcher）对拼写错误或未知命令会明确报错退出，不再无声降级为裸 Pi；若需直接调用裸 Pi，请使用显式子命令 `subworker exec ...` 或 `subworker raw ...`。

## 执行器能力边界

| 维度 | Pi (`--backend pi`) | Agy (`--backend agy`) | Claude Code (`--backend claude`) |
|---|---|---|---|
| **默认状态** | 兼容默认执行器 | 显式指定 `--backend agy` | 显式指定 `--backend claude` |
| **底层通信** | JSON headless / RPC 协议 | 原生 `stream-json` | 原生 `stream-json` 桥接 |
| **思考/推理参数** | `--thinking <level>`（受 profile 校验与提示） | `--effort high\|medium\|low`（默认 High，无 Max） | `--effort <level>` |
| **只读/写入权限** | `--mode read` (受约束 bash) / `--mode write` | read (`plan`) / write (`accept-edits`) | read (`plan`) / write (`auto`) |
| **运行中纠偏** | 支持原生 RPC `steer`（带 `--live`） | 不支持（使用 `continue` 续跑） | 不支持（使用 `continue` 续跑） |
| **专属扩展/能力** | 支持 `--capability docs\|lens\|context\|browser` | 不支持（直接拒绝，不静默忽略） | 不支持（直接拒绝，不静默忽略） |
| **凭证管理** | `~/.pi/agent/` profile 管理 | 使用本机 Agy CLI 登录凭据 | 默认 `commandcode` 复用 Pi 凭据；或 `--provider native` |
| **共享生命周期** | 全部共享：轻量 detached worktree、脏基线携带、wait、cancel、patch 提取与审核后 cleanup | 全部共享 | 全部共享 |

## 文档

macOS v0.4.0 新增 `--backend grok`，原生 Grok Build 1.0.13 已验证；默认 `grok-4.6 / xhigh`，支持精确会话续聊和显式 bypass 权限参数，不支持 Pi live/capability。参数与清理边界见 [Grok Build 指南](docs/macos.md#4-grok-build---backend-grok)。

- [架构与生命周期](docs/architecture.md)
- [安装指南 (Windows)](docs/installation.md)
- [macOS 安装与指南](docs/macos.md)
- [Provider、模型与扩展配置](docs/configuration.md)
- [运行、产物、通知和清理](docs/operations.md)
- [安全边界](docs/security.md)
- [错误与已知限制](docs/errors-and-limitations.md)
- [历史问题与修复记录](docs/history.md)
- [发布记录](docs/releases/release-notes.md)

## 重要边界

- `status=completed` 只代表执行合同成立，不代表代码正确。
- Windows 默认以原生权限运行：不加载自定义 guard，不裁剪工具，正常继承 Pi Skills/扩展/提示模板与进程环境，并传入 Pi 的项目文件信任参数 `--approve`。`--guarded` 显式恢复旧限制。worktree 仅用于候选管理，不是权限沙箱。
- 启动与静默提醒：`--startup-attention`（默认 60 秒）在首事件前提醒，`--silent-reminder`（默认 600 秒）在运行中无新活动时提醒且有新事件时重置，两者均为软提醒，不终止任务（0 关闭）。
- `--consumer <id>` 隔离不同对话/等待者的告警回执（默认 `$CODEX_THREAD_ID` 或 `default`；非 Codex 宿主显式传入）。
- 清理必须发生在宿主审核之后；不要让 Worker 自己删除候选 worktree。

## 最新更新

### 2026-09-16

- 将本地积累的 v0.3.0 至 v0.4.1 正式同步到 GitHub：macOS 统一 `subworker` 入口，并在同一生命周期下支持 Pi、Agy、Claude Code 与 Grok Build。
- 新增 `diagnose`、结构化重试建议、无工具进展提醒、原生权限偏好继承，以及 Grok dispatch/continue 自动 bypass 参数；这些行为均保留审核后清理边界。
- Windows 对齐分支保留本机 WIP/取消/清理修复，增加原生权限默认、Pi 配置继承、in-place、软提醒、独立 consumer、紧凑 wait 和 diagnose；Pi CLI 已验证版本为 0.85.1。详见 [Windows 对齐说明](docs/windows-alignment.md)。

完整记录见 [发布记录](docs/releases/release-notes.md)。

## License

[MIT](LICENSE)
