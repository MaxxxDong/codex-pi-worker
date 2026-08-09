# 发布记录

## v0.1.8 - 2026-08-09

- 不再向普通 Worker 子进程注入 `npm_config_store_dir`，避免 npm 24 对 pnpm 专用兼容变量持续产生 unknown config 警告。
- 共享 pnpm 默认仍使用同一宿主 store；缓存 GC 调用 pnpm 时通过命令参数显式指定已发现的 store 路径。

## v0.1.7 - 2026-08-09

- 默认关闭 hard timeout 和无事件 idle timeout，长时间模型调用、编译或测试不再因固定寿命门禁被终止；显式参数仍可按任务启用。
- 保留已知模型的 thinking 默认值与强度限制；新 provider/model 在显式传入合法 `--thinking` 后交由 Pi 原生模型目录和鉴权处理。
- 共享缓存仍使用 20 GiB 上限和 90 天陈旧规则，但昂贵的深度检查从每小时降为每天一次；运行级垃圾仍在审核后立即清理。

## v0.1.6 - 2026-08-09

- macOS 真实链路验证 Pi 0.84.1 的 JSON Headless 事件、工具调用、会话落盘、`message_end` 与 `agent_settled`。
- Headless wrapper 默认传入 Pi 原生 `--offline`，跳过版本、包、遥测和远程目录等启动期联网操作，不影响实际 provider 请求。
- 保持四个可选能力默认不自动加载，继续通过 `--capability docs|lens|context|browser` 显式启用。

## v0.1.5 - 2026-08-05

- 按配置收敛要求移除 EdgeFN 凭据、模型目录和 Worker profile；DeepSeek 官方 profile 保持不变。

## v0.1.4 - 2026-08-04

- macOS Pi Worker 增加官方 `deepseek/deepseek-v4-flash` 与 EdgeFN `edgefn/DeepSeek-V4-Flash-0731`，两者默认 Max，只允许 High/Max，便于同 runtime 对照测试。
- 修复公开 `bin/pi-worker` 漏转发 `cancel`，避免取消命令被误当作普通 Pi prompt。

## v0.1.3 - 2026-08-04

- macOS 多任务 `wait` 改为任一 success、failed、cancelled 或 attention 即返回，不再被最慢 Worker 阻塞；响应同时包含 `results`、`alerts` 与 `pending`。
- 后续等待只需传入 `pending`，避免短超时健康轮询及重复状态解读。
- 每个 run 从单一 `waiter.json` 改为独立 waiter 文件，多个 Codex 任务等待同一 Worker 时不会互相覆盖；仍使用原有 POSIX 通知与 15 秒本地兜底，没有新增服务或数据库。
- 修复多个 Worker 近同时完成时，迟到的第二个 SIGUSR1 可能让 wait 进程无输出退出的竞态。

## v0.1.2 - 2026-08-04

- macOS 增加单一轻量生命周期状态机和独立活动状态，只描述 Pi Worker 进程，不推断 Codex 任务或线程是否完成。
- 新增 supervisor 管理的 `cancel`；取消后仍原子收口 result、patch、临时 profile 与 run-local 临时文件，结果保持待审核。
- `status` 与 `wait` 会一次收口所有 supervisor 已消失的非终态运行；事件等待保留，纯本地兜底检查从 5 分钟缩短到 15 秒。
- 运行中只保留有界 active tool 元数据，终态按工具名聚合计数；续跑历史继续保留失败原因、attention、模型与 usage，删除工具参数和重复事件。
- 修复 dispatch/continue 启动窗口未立即持久化 supervisor PID，以及 xAI 并行回归测试漏等一个 Worker 的问题。

## v0.1.1 - 2026-08-04

- macOS 临时 profile 保留全部普通用户 Skill，只过滤 Context7、Lens、Context Mode、Playwright 四个可选包的自动资源发现。
- `--capability docs|lens|context|browser` 显式成对加载各自 extension/MCP 与 Skill；Playwright 使用 Skill + 受控 `bash`。
- 相同 ShuaiAPI Sol Medium 请求 A/B 中，默认 input 从 9,374 降至 7,971，减少 1,403 Token（15.0%）；完成时间 3.8 秒与 3.9 秒，无可辨识延迟回归。
- 删除旧 `meta.json/event.json` 兼容清理和 dispatch 前的旧状态目录扫描。
- 默认真实探针确认 19 个普通 Skill 仍可见，四个可选包默认不可见；docs capability 实测恢复 `context7-docs`。

## v0.1.0 - 2026-08-04

- 首个统一版本，保留 Windows Python runtime，并新增独立的 `macos/` Node.js runtime。
- macOS analysis/read 模式移除 `edit/write`，保留只读工具、联网搜索和受提示约束的 `bash`；implementation/write 继续使用 detached worktree。
- macOS result 聚合整次运行的 input/output/cache/reasoning/cost，记录调用次数与 provider-reported reasoning evidence。
- failure/attention 输出 `pending`，要求 Root 立即为仍运行任务重新建立事件等待。
- macOS 共享缓存按 90 天与最旧优先清理并限制为 20 GiB；禁止整库 purge，活跃 Worker 存在时跳过 GC。
- result、session 和候选 worktree 不再按 24 小时自动删除，只允许 Codex 审核后的显式 cleanup。

### 2026-08-03

- 后台传输切换为 Pi 0.83 原生 RPC，增加 receipt 绑定的运行中 `steer` 与 accepted 回执。
- attention 支持多次按序投递，并覆盖连续工具失败、自动重试失败、扩展/压缩错误和 RPC 退出超时。
- `agent_settled` 后先关闭 stdin、排空 stdout 再退出，避免 Windows EPIPE；5 秒未退出则受控终止进程树。
- finalize 后将 `reviewRequired` 和 `continuationAvailable` 同步设为 `false`，保证 result、已删除 session 与 settled receipt 的状态一致。
- analysis 与 implementation 都会先用 `find`/`grep` 解析不确定路径，不再根据类名或符号名直接推断文件名。
- 单次可恢复工具错误继续保留在证据中，但不会触发 `repeated_tool_errors`；首次指定 session ID 时 Pi 的“creating a new session”提示属于预期行为。

### 2026-08-02

- 发布 Windows-first Codex Pi Worker：detached receipt、事件优先 watch、provider attention、session continuation 和 review-gated cleanup。
- implementation 使用独立 Git worktree；analysis 禁用写入型工具。
- 加入 CP936 安全 JSON、无窗口进程、Windows 进程树清理和扩展长度路径删除。
- 将单次原始事件、事件日志、stderr 和最终文本限制在明确上限，修复历史上 DeepSeek Flash 流式日志膨胀到数 GiB 的问题。
- 引入 Worker 自有的 20 GiB uv/pip/npm 共享缓存，任务临时目录按 run 精确清理。
- 发布前修复缓存所有权、已提交成果 finalize 门禁、前置失败结构化结果、stderr 常见凭据脱敏及 shell 路径逃逸检查。
- 普通任务默认使用 implementation；analysis 只用于明确只读任务，两种模式均显式启用 `grep/find/ls`。
- 加入 `--firecrawl` 与 `--playwright` 按需能力，continuation 自动继承；Playwright 仅允许执行固定安装目录下的受信 wrapper。
- 工具失败事件保留最多 2 KiB 的脱敏摘要；`.playwright-cli`、`__pycache__`、`.pytest_cache` 与 `.pyc` 不进入候选 patch。
- 提供幂等的 `prepare_pi_playwright_windows.py`，修复 `pi-playwright 0.1.1` 在 Windows 无法直接启动提升后 CLI 的问题，并补齐从零安装说明。
