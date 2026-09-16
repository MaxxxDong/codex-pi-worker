# 安装指南

## 要求

已验证组合：

- Windows 11 原生环境
- Python 3.12.10
- Node.js 24.18.0；Pi 要求 Node 22.19+
- Git for Windows 2.55+
- `@earendil-works/pi-coding-agent` 0.85.1

Python runtime 只使用标准库；JavaScript guard 只使用 Node 内置模块。

## 1. 安装 Pi

```powershell
npm install -g @earendil-works/pi-coding-agent@0.85.1
pi --version
```

确保 `pi.cmd` 对启动 Codex 的 Windows 用户可见：

```powershell
where.exe pi
```

## 2. 克隆仓库

```powershell
git clone --branch agent/pi-worker-capabilities https://github.com/MaxxxDong/codex-pi-worker C:\CodexWS\Software\codex-pi-worker
```

## 3. 注册 Codex Skill

推荐用 Junction 保持一份源码：

```powershell
$skill = "$env:USERPROFILE\.codex\skills\pi-worker"
$source = "C:\CodexWS\Software\codex-pi-worker"
New-Item -ItemType Junction -Path $skill -Target $source
```

如果 `$skill` 已存在，先检查并备份；不要直接覆盖包含个人修改的目录。新启动的 Codex 任务会读取 `SKILL.md`。

## 升级现有 Windows 安装

仓库通过 Junction 注册时，先确认没有活动 Worker，工作区没有需要保留的修改，再快进拉取当前 Windows 分支。合并 main 时应保留 Windows 修复并本机验证，不能用 main 覆盖：

```powershell
$repo = "C:\CodexWS\Software\codex-pi-worker"
Push-Location $repo
git status --short
git pull --ff-only origin agent/pi-worker-capabilities
Pop-Location
```

如果 `git status --short` 有输出，先提交或备份本机修改，不要直接覆盖。仓库更新不会修改 `~/.pi/agent/` 下的 provider、Key 和模型配置，也不会删除已有 receipt、session 或任务输出。

Windows 继续使用 `~/.codex/skills/pi-worker`，根 SKILL 名称与之匹配。`scripts/subworker.py` 为统一命令入口，不另建第二份 Skill；macOS 使用 macos/SKILL.md 注册 subworker。

## 4. 配置 Pi provider

将 [示例配置](../examples/models.example.json) 中需要的 provider 合并到 `~/.pi/agent/models.json`，并在本机填写 Key。真实配置不得进入本仓库、prompt、receipt 或日志。

```powershell
pi list
```

默认读取本机 Pi settings；显式 provider/model 可使用 Pi 原生或扩展注册的路由，详见 [配置指南](configuration.md)。

## 5. 可选扩展

联网能力可安装：

```powershell
pi install npm:pi-web-access@0.13.0
```

`context-mode` 仅在大型日志、长文件或全仓聚合任务中按需启用：

```powershell
pi install npm:context-mode@1.0.169
```

普通任务不要加 `--context-mode`，以减少启动和上下文开销。

Firecrawl 与 Playwright 也采用按任务加载：

```powershell
pi install npm:pi-mcp-adapter@2.17.0
pi install npm:pi-playwright@0.1.1
```

在 `~/.config/mcp/mcp.json` 中使用环境变量，不要写明文 Key：

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp@3.23.0"],
      "env": { "FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}" },
      "lifecycle": "lazy"
    }
  }
}
```

`pi-playwright 0.1.1` 需要包内依赖、Chromium 和 Windows wrapper 修正：

```powershell
$package = "$env:USERPROFILE\.pi\agent\npm\node_modules\pi-playwright"
Push-Location $package
npm install --ignore-scripts
npm run setup
Pop-Location
python C:\CodexWS\Software\codex-pi-worker\scripts\prepare_pi_playwright_windows.py
```

在 `pi config` 中把 `pi-mcp-adapter` extension 与 `pi-playwright` skill 设为默认 filtered；runtime 会在 `--firecrawl` 或 `--playwright` 时显式加载。Tavily、Firecrawl 等 Key 应持久写入 Windows 用户环境变量，新启动的 Codex/Pi 进程才会继承。

## 6. 验证安装

```powershell
$repo = "C:\CodexWS\Software\codex-pi-worker"
$env:PYTHONDONTWRITEBYTECODE = "1"
python -m unittest discover -s "$repo\tests" -p "test_*.py"
node --test "$repo\tests\test_pi_worker_guard.mjs"
```

真实 provider smoke 会产生费用，建议在独立、无敏感信息的小型 Git 仓库中执行。
