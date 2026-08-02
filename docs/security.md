# 安全边界

## 威胁模型

本工具用于用户授权的代码库和可信任务。Pi 与 Codex 以当前 Windows 用户权限运行；worktree、tool guard、环境白名单和 review gate 用于降低误操作风险，不构成恶意代码隔离。

## 已实现防护

- implementation 只从干净 HEAD 创建 detached worktree。
- direct write/edit 路径必须位于 execution worktree，解析 realpath 防止 symlink/junction 逃逸。
- shell guard 阻断危险递归删除、磁盘命令、明显路径逃逸及 source/home mutation。
- runtime 自有目录删除必须通过 owned-root 校验，拒绝删除根本身、根外路径和链接目标。
- Worker 环境采用显式白名单，避免把无关秘密继承给模型工具。
- receipt/result 使用同目录临时文件原子替换。
- runner 先写 receipt 再通过 launch gate 执行，失败终止整个进程树。
- 候选在 Codex 审核前保持 `pending_review`，Worker 无权自行 finalize。

## 不是 OS 沙箱

`pi_worker_guard.mjs` 解析工具调用和命令字符串。Shell 语法、解释器、脚本和原生 API 很难由正则完全覆盖，因此：

- 不要运行来自不可信来源的 prompt。
- 不要把 implementation 指向含高价值未提交数据的用户目录。
- 需要强隔离时使用虚拟机、容器、Windows Sandbox 或权限受限账户。
- `sourceEscapeDetected` 等审计字段只能反映已实现检查，不能证明不存在所有逃逸。

## Receipt 信任边界

Receipt 含 source、result、session、runtime 和 worktree 的绝对路径。`continue`/`finalize` 只接受本工具生成且未被修改的 receipt；不要处理下载、聊天或第三方提供的 receipt。

## 凭据和日志

- Provider Key 只存于私有 `~/.pi/agent/models.json`。
- Prompt 不得包含 Key。
- stderr 会做常见 Authorization/token 模式脱敏，但无法保证识别所有自定义秘密格式。
- Patch、final text、tool output 和 session 可能包含私有源码；按敏感证据处理。
- 对话中曾暴露的 Key 应立即撤销并轮换，不能因为仓库扫描无命中就继续使用。

## 删除策略

只有 runtime 创建、receipt 绑定且位于 owned root 的 worktree/session/run temp 可以自动删除。用户项目、HOME、盘符根和任意外部路径都不属于自动清理范围。接受带 patch 的实现时，必须先集成并验证，再传 `--changes-integrated`。
