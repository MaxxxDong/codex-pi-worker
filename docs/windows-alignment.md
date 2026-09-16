# Windows 与 macOS 对齐（2026-09-16）

入口：[README](../README.md)。基线为上游 `d70d7d8`，合并 Windows 分支已有的 WIP、取消和 orphan 清理修复。

## 已对齐的 Windows 行为

- Pi 默认完整原生权限，传 `--approve`；不加载 guard、不传工具白名单、不禁 Skills/扩展/模板，保留扩展/MCP 工具并启用 grep/find/ls/PowerShell。
- provider/model/thinking 读取当前 Pi settings，显式参数优先。扩展型 provider 交由 Pi 原生注册和验证，不维护第二份完整模型表。未改本机凭据。
- implementation 自动携带 WIP 基线；新增 in-place 支持非 Git 目录，analysis 仅提示只读。显式 guarded 才恢复旧权限限制。
- 默认取消 idle 强制超时；60秒启动提醒、600秒静默/无工具提醒仅通知，0关闭。analysis 无工具提醒默认关闭。
- wait 返回第一个就绪事件，默认紧凑结果，full 可取完整结果；consumer 按对话独立确认提醒，内部本地检查不需要宿主模型轮询。
- diagnose 只读已有进展/结果并给重试建议，不自动重试或切换路由。
- 原有 Windows 隐藏进程、RPC steer、同 session continuation、审核后 owned 路径清理继续使用。

## 平台边界

macOS 的 Pi read 模式仍裁剪 write/edit；本次 Windows 按用户要求默认全部工具，仅提示约束只读。Mac Agy/Claude bypass 继承原生用户设置，Grok 默认 bypass。Windows 本批的执行器仍是 Pi；Agy/Claude/Grok Mac 适配器已同步源码，不能据此宣称 Windows 已支持这些后端。Windows 不执行 POSIX signal/进程组和 `/Users/max` 路径。

Windows 保留 `pi-worker` Skill 名称/旧脚本入口，避免已打开任务的路径失效；新增 `scripts/subworker.py` 统一命令是轻薄转发，不另建生命周期。`SUBWORKER_STATE_ROOT` 优先于旧 `PI_WORKER_ROOT`；默认物理目录仍是 `C:\piw`。

runtime 自动删除仅限已审核的自有 worktree/session/临时目录，共享缓存保留20 GiB容量策略。默认权限开放不意味着 cleanup 可以删除用户工作区。

## 验证范围

Windows Python/Node 定向及回归、Pi 0.85.1 CLI 与真实 canary；具体测试与提交结果见本次交付。Mac 代码从上游合并，本机不代替 macOS 运行验收。
