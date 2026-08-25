# 发布记录

### 2026-08-25

- implementation 支持 staged、unstaged 和非 ignored untracked WIP 快照；不再要求调用方 stash，源工作区在启动前后保持不变。
- 隔离 worktree 内创建无 hook 的临时 baseline，`changes.patch` 只包含 Worker 相对初始 WIP 的增量；ignored 依赖和缓存不复制。
- 增加 `--evidence-file`，把明确授权的外部证据复制进 worktree，再由 Python/Node 处理，不弱化源仓库 guard。
- orphaned/no-result 运行只允许 rejected finalize，并校验 job、owner/latest receipt、run ID、结果路径和 owned 目录后生成明确 synthetic failure 记录。
- 精简 `SKILL.md` 热路径；steer、cancel、continuation 和条件扩展细节按需读取运维文档。

### 2026-08-04

- 修复 Windows/MSYS `/c/...` 工作树路径被误判为越界，以及 `build.gradle.kts`、`gradle/wrapper` 等只读路径被误判为执行命令。
- 增加 receipt 绑定的命名事件取消：runner 自行终止进程树、写 `cancelled` 结果并保留候选，等待 Codex 审核后再清理。
- watch 明确返回 runtime job 的 `lifecycleState`；连续工具错误 attention 附带最近三条限长脱敏摘要，减少再次读取大日志。
- 明确并验证 multi-receipt watch 的 first-ready 合同：任一并发 Worker 完成、失败或异常都会先唤醒，不再按 receipt 串行等待。

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
