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
| `deepseek` | `deepseek-v4-flash` |
| `ahzm` | `glm-5.3`, `glm-5.3-flash` |
| `commandcode` | `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4-flash`, `google/gemini-3.7-flash`, `Qwen/Qwen3.8-Flash`, `Qwen/Qwen3.8-Max` |
| `xai` | `grok-4.5`, `grok-4.6` |

派发时必须显式指定 provider 和模型；已移除的 `opencode-go` 不再作为 Worker profile。Qwen 3.8 Flash 默认 thinking 为 `max`；Qwen 3.8 Max 默认 `xhigh`。未知 provider/model 仍可通过显式 `--thinking` 使用。

## 启动覆盖

```powershell
python scripts\start_pi_worker.py `
  --cwd C:\repo `
  --prompt-file C:\task.md `
  --mode analysis `
  --output-dir C:\evidence `
  --provider commandcode `
  --model google/gemini-3.7-flash `
  --thinking high
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
| `TAVILY_API_KEY` | Tavily 搜索；从用户环境按白名单传入 Worker |
| `FIRECRAWL_API_KEY` | Firecrawl MCP；从用户环境按白名单传入 Worker |

Worker 环境采用白名单继承。Java、Android、Rust、Go、Node、Python 等常见工具链变量会保留；无关秘密默认不传给子进程。联网搜索 Key 只有列入安全白名单时才会传递，因此应按最小权限配置。

## 扩展加载策略

- `pi_worker_guard.mjs` 始终加载。
- Pi 自身已配置的常规扩展、skills 和 web 工具保持可用。
- 两种模式都显式启用 `grep/find/ls`。默认 `implementation` 另有 `bash/edit/write`；只有明确只读任务才传 `--mode analysis`。
- `context-mode` 只有显式 `--context-mode` 才额外加载，避免简单任务为大日志能力付固定成本。
- `pi-mcp-adapter` 与 Firecrawl 只有显式 `--firecrawl` 才加载；MCP 配置使用 `${FIRECRAWL_API_KEY}`，不保存明文 Key。
- `pi-playwright` 只有显式 `--playwright` 才加载，并要求 implementation 模式。
- session 默认启用，因为 continuation 依赖同一 Pi session；不是可随意删除的开销项。

## Responses 兼容说明

Pi 使用自己的文本 prompt、session 和 JSON 事件协议。它不会向 provider 发送 Codex Multi-Agent V2 专用的 `agent_message` 输入项。因此“标准 Responses 文本可用”不等于“可以直接作为 Codex 原生 v2 子代理”；反过来，原生 `agent_message` 不兼容也不代表 Pi 路径不可用。

## Agy 后端

macOS 可通过 `--backend agy` 直接调用当前用户安装的 `~/.local/bin/agy`，不经过 Pi provider，也不启动 `agy-staff` companion。Agy 使用自己的登录、模型目录、MCP、插件和 Skill；本项目只复用 worktree、事件等待、取消、补丁与审核后清理。

```bash
pi-worker dispatch --backend agy --run-id review-1 --mode read --workdir /absolute/repo -- \
  --model gemini-3.8-flash-high --effort high "Review the named files."
```

- effort 只接受 Agy 原生 `low|medium|high`；也可用 `--thinking` 作为同义参数。
- read 使用 Agy `plan`，write/in-place 使用 `accept-edits`。
- 默认不传 `--dangerously-skip-permissions`。可信单次任务如明确需要，可把该 Agy 原生参数放在 `--` 后；不要写入全局默认。
- `--json-schema` 等非生命周期参数会直传 Agy。`--model`、effort、输出格式、conversation、print timeout 和执行 mode 由 Worker 统一管理。
- Agy 的 account-level conversation 数据由 Agy 自身管理；`cleanup` 只删除 Worker 拥有的 result、TMP 和 worktree。

## Claude Code 后端

macOS 可通过 `--backend claude` 直接调用 Claude Code。默认 provider 是 `commandcode`，默认模型是 `deepseek/deepseek-v4-flash`，默认 effort 是 `max`：

```bash
pi-worker dispatch --backend claude --run-id claude-fix --mode write --source /absolute/repo -- \
  --provider commandcode --model deepseek/deepseek-v4-flash --effort max \
  "Implement the bounded fix and run focused tests."
```

CommandCode 的 OSS 模型不能直接使用其 Anthropic Messages endpoint。Worker 因此让 Claude Code 保持 Messages 输入，在本次进程内启动仅监听 `127.0.0.1` 的临时桥，再转换到 CommandCode Chat Completions。桥只从 Pi 的 `auth.json` 在内存读取 `commandcode` Key，不写入 result、日志、Claude 配置或仓库；Claude 退出后桥立即终止。

- `--provider native` 使用当前 Claude Code 登录和全局模型配置，不启动桥。
- read 使用 Claude `plan`，write 使用 `auto`，in-place 使用 `acceptEdits`；显式 `--dangerously-skip-permissions` 仍由调用方自行承担。
- 默认通过 `--disallowedTools` 禁止 Claude 再派生 Agent、Task、Workflow 或定时任务，避免后台 Worker 形成不可见的第二层生命周期；确需内部编排时显式传 `--allow-orchestration`。
- Claude 的 Skill、MCP、插件和 `CLAUDE.md` 仍按 Claude Code 原生规则加载；仅 CommandCode endpoint、模型和凭据通过本次命令级 `--settings` 覆盖，用户全局文件保持不变。
- Claude 当前不支持 Worker 的 `--capability`、`--live` 或 `steer`；`continue` 通过 Claude session ID 续跑并复用同一 worktree。
