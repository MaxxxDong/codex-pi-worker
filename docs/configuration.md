# Provider、模型与扩展配置

## 私有配置边界

Pi provider 配置位于 `~/.pi/agent/models.json`。它通常包含明文 API Key，必须保持本机私有：

- 不复制到 Skill 或仓库。
- 不写进 prompt、receipt、issue、测试快照或调试日志。
- 不把 `~/.pi/agent` 整目录当作发布内容。

仓库只提供 [占位示例](../examples/models.example.json)。

## 当前路由白名单

`runtime_support.py` 对 provider/model 做 fail-closed 校验：

| Provider | 允许模型 |
|---|---|
| `opencode-go` | `deepseek-v4-flash` |
| `shuaiapi` | `gpt-5.6-luna`, `gpt-5.6-sol` |
| `shuaiapi-grok` | `grok-4.5` |
| `krill` | `grok-4.5` |
| `krill-sol` | `gpt-5.6-sol` |

默认路由为 `opencode-go/deepseek-v4-flash`，thinking 为 `max`。如需新增 provider，必须同时更新私有 `models.json`、`PROVIDER_MODELS` 和测试；不要通过静默 fallback 掩盖拼写或认证错误。

## 启动覆盖

```powershell
python scripts\start_pi_worker.py `
  --cwd C:\repo `
  --prompt-file C:\task.md `
  --mode analysis `
  --output-dir C:\evidence `
  --provider shuaiapi `
  --model gpt-5.6-sol `
  --thinking medium
```

允许的 thinking：`off|minimal|low|medium|high|xhigh|max`。是否真正支持由模型/provider 决定；runtime 检测到 reasoning 被忽略会 fail closed。

## 环境变量

| 变量 | 作用 |
|---|---|
| `PI_WORKER_ROOT` | runtime 根；Windows 默认 `C:\piw` |
| `PI_WORKER_DISABLE_CACHE_GC=1` | 禁止后台缓存修剪 |
| `UV_CACHE_DIR` | 显式覆盖 Worker 共享 uv cache |
| `PIP_CACHE_DIR` | 显式覆盖 Worker 共享 pip cache |
| `npm_config_cache` | 显式覆盖 Worker 共享 npm cache |
| `PI_CODING_AGENT_DIR` | Pi agent 目录；用于定位可选 context-mode |
| `PI_ALLOW_BROWSER_COOKIES` | 显式允许 Pi Web 访问浏览器 cookies |

Worker 环境采用白名单继承。Java、Android、Rust、Go、Node、Python 等常见工具链变量会保留；无关秘密默认不传给子进程。联网搜索 Key 只有列入安全白名单时才会传递，因此应按最小权限配置。

## 扩展加载策略

- `pi_worker_guard.mjs` 始终加载。
- Pi 自身已配置的常规扩展、skills 和 web 工具保持可用。
- `context-mode` 只有显式 `--context-mode` 才额外加载，避免简单任务为大日志能力付固定成本。
- session 默认启用，因为 continuation 依赖同一 Pi session；不是可随意删除的开销项。

## Responses 兼容说明

Pi 使用自己的文本 prompt、session 和 JSON 事件协议。它不会向 provider 发送 Codex Multi-Agent V2 专用的 `agent_message` 输入项。因此“标准 Responses 文本可用”不等于“可以直接作为 Codex 原生 v2 子代理”；反过来，原生 `agent_message` 不兼容也不代表 Pi 路径不可用。
