# macOS 安装与升级

macOS 实现位于仓库的 `macos/`，使用 Node.js 运行，不依赖 Windows Python runtime。

## 要求

- macOS
- Node.js 22.19+
- Git
- Pi CLI 0.83+
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

完整命令和模型默认值以 [`macos/SKILL.md`](../macos/SKILL.md) 为准。
