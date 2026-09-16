# macOS 安装与指南

macOS 实现位于仓库的 `macos/` 目录，使用 Node.js 运行，不依赖 Windows Python runtime。当前版本为 **v0.4.1**，统一品牌与 Skill 名称为 **Subworker**。

## 要求

- macOS
- Node.js 22.19+
- Git
- Pi CLI 0.83+；当前验证版本为 0.84.1
- 已配置的 `~/.pi/agent/auth.json`、`models.json` 与 `settings.json`
- 可选 Agy CLI 1.1.8+；仅使用 `--backend agy` 时需要有效 Agy 登录
- 可选 Claude Code 2.1.252+；仅使用 `--backend claude` 时需要。CommandCode 模式复用 Pi 中已有的 `commandcode` 凭据
- 可选 Grok Build；当前验证版本 1.0.13，仅使用 `--backend grok` 时需要有效原生登录

## 安装与部署规划

Subworker 规划作为全局通用 Skill 安装在 `~/.codex/skills/subworker`，可供任何宿主 IDE（如 Codex 等）通过同一入口调用：

```bash
git clone https://github.com/MaxxxDong/codex-pi-worker.git "$HOME/codex-pi-worker"
mkdir -p "$HOME/.codex/skills"
ln -s "$HOME/codex-pi-worker/macos" "$HOME/.codex/skills/subworker"
```

> **注意**：
> - 如果 `~/.codex/skills/subworker` 已存在，先确认它是否为旧目录或符号链接，再人工迁移；
> - 仓库当前仍托管于 `MaxxxDong/codex-pi-worker`；
> - 不要在开发 worktree 中直接执行全局部署，由 Root 审核后部署。

## 启动器（macos/bin/subworker）与环境规范

`macos/bin/subworker` 是 macOS 上的唯一可执行入口：

1. **防误启动与命令解析**：启动器严格校验子命令。任何拼写错误（如 `dispacth`）或未知命令均会明确报错并退出，绝对不会误将 typo 作为 bare prompt 降级启动 Pi。
2. **显式裸 Pi 启动**：若需要脱离编排生命周期直接运行 Pi，请使用显式子命令：
   ```bash
   subworker exec [pi_args...] "prompt"
   # 或
   subworker raw [pi_args...] "prompt"
   ```
3. **环境变量规范**：
   - 官方公开环境变量统一采用 `SUBWORKER_*` 前缀（例如 `SUBWORKER_NODE_BIN`、`SUBWORKER_PI_BIN`、`SUBWORKER_STATE_ROOT`、`SUBWORKER_AGENT_SOURCE`、`SUBWORKER_LAUNCHER`）；
   - 旧环境变量 `PI_WORKER_*` 保留作为向后兼容输入；
   - Pi 本身的内置变量（如 `PI_CODING_AGENT_DIR`）保持不变；
   - 启动器先检查 `~/.local/node-lts/bin`，再回退到 `PATH`。
4. **沙箱网络检查**：若检测到处于 Codex Seatbelt 且禁用了网络，`dispatch`/`continue` 会明确提示失败，要求调用方以 `sandbox_permissions="require_escalated"` 重新运行。

## 持久化与存储兼容

为了保证历史任务的稳定性和兼容性，现有 `pi-worker/runs` 物理目录在持久层保持不变。新命令不会因品牌升级导致旧任务、已有 worktree 或会话无法发现或无法清理。

## 四执行器能力边界

Subworker 接入了 Pi、Agy、Claude Code 与 Grok Build 四个执行器，在统一的工作区与生命周期治理下运行：

### 1. Pi (`--backend pi`，兼容默认)
- **定位**：兼容默认执行器，具备最完整的内置能力与工具支持。
- **能力**：支持 JSON/RPC、`--live` 运行中 RPC `steer` 纠偏、`--capability docs|lens|context|browser`（Context7, Lens, Context Mode, Playwright）。
- **配置与模型**：使用受管的独立 agent profile 副本，支持 `--thinking <level>`。

### 2. Agy (`--backend agy`)
- **定位**：直接调用 Agy CLI，面向 Gemini 模型与 Agy 原生工作流。
- **能力**：基于原生 `stream-json`，设置 24 小时 internal print wait 消除自带的 5 分钟截断；read 映射为 `plan`，write 映射为 `accept-edits`。
- **参数**：支持 `--effort low|medium|high`（默认 High，无 Max；支持 `--thinking` 别名）。
- **边界**：不嵌套 `agy-staff` 第二生命周期；不支持 `--capability`、`--live` 或 `steer`（若传入会明确拒绝，不静默忽略）；续跑使用统一的 `continue` 命令。

### 3. Claude Code (`--backend claude`)
- **定位**：直接调用 Claude Code CLI，面向 Claude 原生或 CommandCode 代理模型。
- **能力**：基于原生 stream-json；`--provider commandcode`（默认）通过仅监听 `127.0.0.1` 的临时回环桥将 Claude Messages 转换为 CommandCode Chat Completions；`--provider native` 使用本地 Claude 登录。
- **权限与编排**：未选择 bypass 时，read 映射为 `plan`，write 映射为 `auto`；默认禁用内部 Agent/Task/Workflow 编排，可用 `--allow-orchestration` 显式开放。
- **原生全局权限继承**：Agy `~/.gemini/antigravity-cli/settings.json` 的 `toolPermission: "always-proceed"`，或 Claude `~/.claude/settings.json` 的 `permissions.defaultMode: "bypassPermissions"`，会让新任务和续跑显式传入 `--dangerously-skip-permissions`。参数记录在 result 的 `backendArgs`，可用 `diagnose` 确认。该模式跳过工具审批，不是操作系统授权，也不提供强制写入隔离；仍需遵守任务范围并在审核后清理。Pi 没有对应参数，不额外注入。
- **边界**：不支持 `--capability`、`--live` 或 `steer`；续跑使用统一的 `continue` 命令。

### 4. Grok Build (`--backend grok`)
- 使用原生 `streaming-messages-json`，复用 Messages 消息解析；默认模型 `grok-4.6`、effort `xhigh`，可显式指定模型与 `low|medium|high|xhigh`。
- runtime 在 dispatch 和 continue 自动补齐原生 `--permission-mode bypassPermissions --always-approve`，调用方无需传审批参数，旧任务续聊也生效；不修改全局配置。read 模式同样跳过原生审批，只读及路径范围由指令约束，不是强制隔离。
- 使用本机 Grok 登录、Skills、MCP 与插件，不复制另一套全局配置；首次分配唯一 session ID，`continue` 使用同一 ID 的 `--resume`。
- 复用 `wait`、`cancel`、patch 与审核后 `cleanup`。清理仅删除本次分配的本地 Grok 会话目录，保留共享 prompt history，不调用远程会话删除。没有原生报告的 reasoning token 保持未知。
- 不支持 `--live`、`steer` 或 Pi `--capability`。

```bash
$HOME/.codex/skills/subworker/bin/subworker dispatch --backend grok --run-id grok-task \
  --mode write --source /absolute/repo -- \
  --model grok-4.6 --effort xhigh --dangerously-skip-permissions "完成限定范围的修改并运行相关测试"
```

### Skills 与扩展支持
- 已配置的 Pi Skills 正常加载，四个可选扩展能力（`docs`、`lens`、`context`、`browser`）通过 `--capability` 按需显式启用；Agy 和 Claude Code 直接使用各自宿主已安装的原生 Skills、MCP 服务器与插件。

## 验证与使用

```bash
$HOME/.codex/skills/subworker/bin/subworker profiles
node --test "$HOME/.codex/skills/subworker/tests/launcher.test.mjs"
node --test "$HOME/.codex/skills/subworker/tests/events.test.mjs"
```

普通只读任务使用 `--mode read --workdir`；实现任务使用 `--mode write --source`。Worker 结束后先审核 `result.json` 和可选 `changes.patch`，再执行：

```bash
$HOME/.codex/skills/subworker/bin/subworker cleanup --reviewed yes --run-id RUN_ID
```

按需诊断检查（只读检查运行状态、配置事实、错误告警与建议）：

```bash
$HOME/.codex/skills/subworker/bin/subworker diagnose --run-id RUN_ID
```

Agy 示例：

```bash
$HOME/.codex/skills/subworker/bin/subworker dispatch \
  --backend agy --run-id agy-fix --mode write --source /absolute/repo -- \
  --model gemini-3.8-flash-high --effort high \
  "Implement the bounded fix and run focused tests."
```

Claude Code 示例：

```bash
$HOME/.codex/skills/subworker/bin/subworker dispatch \
  --backend claude --run-id claude-fix --mode write --source /absolute/repo -- \
  --provider commandcode --model deepseek/deepseek-v4-flash --effort max \
  "Implement the bounded fix and run focused tests."
```

## 生命周期与通知机制

- `result.json` 只有一套轻量生命周期：`starting -> running -> stopping -> finalizing -> success|failed|cancelled`。`activity` 单独表示 `waiting_event`、`waiting_model` 或 `running_tools`。
- `wait` 会在任一 Worker 成功、失败、取消或出现 attention 时立即返回，并同时给出已完成的 `results`、异常 `alerts` 和仍运行的 `pending`。后续只对 `pending` 再执行一次长等待；不要用短超时或 `status` 做健康轮询。同一 run 支持多个独立等待者，互不覆盖。
- 启动与静默提醒：`--startup-attention SECONDS`（默认 60 秒）在首事件到来前检测启动静默；`--silent-reminder SECONDS`（默认 600 秒）在运行中无新活动时检测静默并在有新事件时重置。两者均为软提醒（0 关闭），绝不终止任务。
- `--consumer <id>` 用于标记并区分独立会话/等待者的告警回执（默认使用 `$CODEX_THREAD_ID`，未设置时为 `default`；非 Codex 宿主显式传入会话标识），保证多个独立等待者不会相互覆盖或丢失通知。
- `wait --timeout` 只限制当前等待命令，终止任务必须使用 `cancel` 经 supervisor 安全结束并保留证据。
- write 模式直接携带 staged、unstaged 与非忽略 untracked 基线，调用方不得因仓库 dirty 拒绝启动。
- 完整命令和规范以 [`macos/SKILL.md`](../macos/SKILL.md) 为准。
