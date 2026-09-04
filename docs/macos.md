# macOS 安装与升级

macOS 实现位于仓库的 `macos/`，使用 Node.js 运行，不依赖 Windows Python runtime。

## 要求

- macOS
- Node.js 22.19+
- Git
- Pi CLI 0.83+；当前验证版本为 0.84.1
- 已配置的 `~/.pi/agent/auth.json`、`models.json` 与 `settings.json`
- 可选 Agy CLI 1.1.8+；仅使用 `--backend agy` 时需要有效 Agy 登录

## 安装

```bash
git clone https://github.com/MaxxxDong/codex-pi-worker.git "$HOME/codex-pi-worker"
mkdir -p "$HOME/.codex/skills"
ln -s "$HOME/codex-pi-worker/macos" "$HOME/.codex/skills/pi-worker"
```

如果 `~/.codex/skills/pi-worker` 已存在，先确认它是否为旧目录或符号链接，再人工迁移；安装脚本不会替用户删除它。

## 验证

```bash
$HOME/.codex/skills/pi-worker/bin/pi-worker profiles
node --test "$HOME/.codex/skills/pi-worker/tests/events.test.mjs"
```

普通只读任务使用 `--mode read --workdir`；实现任务使用 `--mode write --source`。Worker 结束后先审核 `result.json` 和可选 `changes.patch`，再执行：

```bash
$HOME/.codex/skills/pi-worker/bin/pi-worker cleanup --reviewed yes --run-id RUN_ID
```

默认执行器仍是 Pi。Agy 复用同一生命周期和 worktree：

```bash
$HOME/.codex/skills/pi-worker/bin/pi-worker dispatch \
  --backend agy --run-id agy-fix --mode write --source /absolute/repo -- \
  --model gemini-3.8-flash-high --effort high \
  "Implement the bounded fix and run focused tests."
```

Agy 使用原生 `stream-json`，终态 `conversation_id` 用于 `continue`。默认内部 print wait 为 24 小时，只避免 Agy 自带的五分钟截断；Worker 自身仍只在调用方显式设置 `--hard-timeout` 时限制寿命。`--capability`、`--live` 和 `steer` 当前只属于 Pi。

`result.json` 只有一套轻量生命周期：`starting -> running -> stopping -> finalizing -> success|failed|cancelled`。`activity` 单独表示 `waiting_event`、`waiting_model` 或 `running_tools`；它不判断 Codex 任务是否完成。`status` 会派生进程存活信息并收口所有已消失 supervisor，运行时不需要额外数据库或心跳进程。

`wait` 会在任一 Worker 成功、失败、取消或出现 attention 时立即返回，并同时给出已完成的 `results`、异常 `alerts` 和仍运行的 `pending`。后续只对 `pending` 再执行一次长等待；不要用 1–2 分钟短超时或 `status` 做健康轮询。同一 run 支持多个独立等待者，互不覆盖。不同 attention 最多保留 8 条并按序各投递一次；已投递回执不会在终态通知时被误删。

`wait --timeout` 只限制当前等待命令，不会停止 Worker。要终止任务时必须经过 supervisor：

```bash
$HOME/.codex/skills/pi-worker/bin/pi-worker cancel --run-id RUN_ID --reason "Task superseded" --timeout 30
```

这样 child 会先停止，随后仍生成可审核的 `result.json` 和可选 patch。不要直接 `kill` supervisor。

普通用户 Skill 默认加载。Context7、Lens、Context Mode 和 Playwright 必须按任务显式启用：

```bash
$HOME/.codex/skills/pi-worker/bin/pi-worker dispatch ... --capability docs -- ...
$HOME/.codex/skills/pi-worker/bin/pi-worker dispatch ... --capability lens -- ...
$HOME/.codex/skills/pi-worker/bin/pi-worker dispatch ... --capability context -- ...
$HOME/.codex/skills/pi-worker/bin/pi-worker dispatch ... --capability browser -- ...
```

Headless Worker 默认使用 Pi 原生 `--offline`，只跳过启动期版本、包、遥测和远程模型目录检查，不会禁用实际模型请求。Pi 0.84.1 的 JSON/RPC `message_update` 已改为纯增量；runtime 只以完整 `message_end` 和 `agent_settled` 判定终态，因此无需累计流式消息。

Worker 默认不设置 hard timeout 或无事件 idle timeout；有明确期限的任务再显式传入。backend 启动后 60 秒没有任何事件时只发 `startup_silent` 软提醒，不停止任务；可用 `--startup-attention SECONDS` 调整，设为 `0` 关闭。已知模型只在调用方省略 `--thinking` 时提供默认值，不再限制调用方选择；新 provider/model 显式传入合法值即可。write 模式直接携带 staged、unstaged 与非忽略 untracked 基线，调用方不得因仓库 dirty 拒绝启动。共享缓存深度检查最多每天一次，运行级 TMP、session 和 worktree 仍在审核后立即清理。通过 Codex 执行 `cleanup` 时应使用 host 权限；若仍处于 Seatbelt，run 清理照常完成，但共享缓存 GC 会明确跳过，避免逐文件 `EPERM` 和巨量诊断输出。

启动器可用 `PI_WORKER_NODE_BIN` 和 `PI_WORKER_PI_BIN` 显式指定可执行文件；未指定时先检查 `~/.local/node-lts/bin`，再回退到 `PATH`。模型增量事件按 250 ms 合并写入状态，工具开始/结束、状态切换、attention 和终态仍立即持久化。终态会清理本轮进程组中仍存活的后台后代，避免测试服务器或辅助进程残留。

完整命令和模型默认值以 [`macos/SKILL.md`](../macos/SKILL.md) 为准。
