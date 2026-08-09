# macOS 安装与升级

macOS 实现位于仓库的 `macos/`，使用 Node.js 运行，不依赖 Windows Python runtime。

## 要求

- macOS
- Node.js 22.19+
- Git
- Pi CLI 0.83+；当前验证版本为 0.84.1
- 已配置的 `~/.pi/agent/auth.json`、`models.json` 与 `settings.json`

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

`result.json` 只有一套轻量生命周期：`starting -> running -> stopping -> finalizing -> success|failed|cancelled`。`activity` 单独表示 `waiting_event`、`waiting_model` 或 `running_tools`；它不判断 Codex 任务是否完成。`status` 会派生进程存活信息并收口所有已消失 supervisor，运行时不需要额外数据库或心跳进程。

`wait` 会在任一 Worker 成功、失败、取消或出现 attention 时立即返回，并同时给出已完成的 `results`、异常 `alerts` 和仍运行的 `pending`。后续只对 `pending` 再执行一次长等待；不要用 1–2 分钟短超时或 `status` 做健康轮询。同一 run 支持多个独立等待者，互不覆盖。

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

Worker 默认不设置 hard timeout 或无事件 idle timeout；有明确期限的任务再显式传入。已知模型继续使用既定思考默认值和限制，新 provider/model 只要显式传入合法 `--thinking` 即可交给 Pi 原生目录验证。共享缓存深度检查最多每天一次，运行级 TMP、session 和 worktree 仍在审核后立即清理。

完整命令和模型默认值以 [`macos/SKILL.md`](../macos/SKILL.md) 为准。
