# 安装指南

## 要求

已验证组合：

- Windows 11 原生环境
- Python 3.12.10
- Node.js 24.18.0；Pi 要求 Node 22.19+
- Git for Windows 2.55+
- `@earendil-works/pi-coding-agent` 0.83.0

Python runtime 只使用标准库；JavaScript guard 只使用 Node 内置模块。

## 1. 安装 Pi

```powershell
npm install -g @earendil-works/pi-coding-agent@0.83.0
pi --version
```

确保 `pi.cmd` 对启动 Codex 的 Windows 用户可见：

```powershell
where.exe pi
```

## 2. 克隆仓库

```powershell
git clone https://github.com/MaxxxDong/codex-pi-worker C:\CodexWS\Software\codex-pi-worker
```

## 3. 注册 Codex Skill

推荐用 Junction 保持一份源码：

```powershell
$skill = "$env:USERPROFILE\.codex\skills\pi-worker"
$source = "C:\CodexWS\Software\codex-pi-worker"
New-Item -ItemType Junction -Path $skill -Target $source
```

如果 `$skill` 已存在，先检查并备份；不要直接覆盖包含个人修改的目录。新启动的 Codex 任务会读取 `SKILL.md`。

## 4. 配置 Pi provider

将 [示例配置](../examples/models.example.json) 中需要的 provider 合并到 `~/.pi/agent/models.json`，并在本机填写 Key。真实配置不得进入本仓库、prompt、receipt 或日志。

```powershell
pi list
```

provider 名称与模型必须匹配 runtime 白名单，详见 [配置指南](configuration.md)。

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

## 6. 验证安装

```powershell
$repo = "C:\CodexWS\Software\codex-pi-worker"
$env:PYTHONDONTWRITEBYTECODE = "1"
python -m unittest discover -s "$repo\tests" -p "test_*.py"
node --test "$repo\tests\test_pi_worker_guard.mjs"
```

真实 provider smoke 会产生费用，建议在独立、无敏感信息的小型 Git 仓库中执行。
