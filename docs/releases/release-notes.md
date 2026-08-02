# 发布记录

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
