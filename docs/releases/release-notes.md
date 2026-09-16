# 发布记录

## Windows 对齐批次 - 2026-09-16

- 合并 main 的 Mac Subworker v0.4.1 源码和文档，保留 Windows 分支 WIP 快照、取消与 orphan rejected finalize 修复。
- Windows 默认原生权限和环境，加载 Skills/扩展/提示模板，启用全部原生工具及搜索工具；guard 改为显式 `--guarded`。本机 Pi 已升级为 npm 正式版 0.85.1，CLI 与模型目录正常；真实 canary 被当前 provider 余额不足（HTTP 400）阻断，不宣称模型验收成功。
- 保留脱敏 provider errorMessage 到 compact event/result，并即时发送 provider_error attention，避免余额不足等错误只剩空的失败状态。
- 默认模型路由继承 Pi settings；新增 in-place、零默认硬超时、启动/静默/工具进展软提醒、consumer 独立告警、紧凑 wait/显式 full 和只读 diagnose。
- Windows 保留现有 pi-worker Skill 路径；subworker.py 只转发现有 Python 生命周期。Mac 多执行器没有冒充 Windows 支持。详细边界见 [Windows 对齐说明](../windows-alignment.md)。

## 2026-09-16 - GitHub 发布批次

- 将此前仅保存在本机的 v0.3.0、v0.3.1、v0.3.2、v0.4.0 与 v0.4.1 一次性同步到现有 GitHub 仓库。
- 用户可见变化集中在 macOS Subworker：统一入口与环境变量、多执行器编排、诊断与重试建议、进展提醒、权限偏好继承，以及 Grok Build 后端。
- Windows Python runtime 本批没有行为变化；Windows 升级只需在干净工作区拉取 `main`，原有本机 Pi provider、Key、receipt、session 和任务输出不会由仓库更新覆盖。

## v0.4.1 - 2026-09-08

- 按用户授权将 Grok bypass 作为 runtime 默认：dispatch 和 continue 自动提供参数，避免调用 agent 漏传导致后台终端审批取消。旧任务下次续聊同样生效，已运行进程不变。
- 不修改全局配置；read 模式也跳过原生审批，其只读范围依靠提示约束。定向测试 7/7，覆盖无参数派发和旧任务续聊。

## v0.4.0 - 2026-09-08

- macOS 新增 Grok Build 原生后端，默认 `grok-4.6 / xhigh`；共享派发、消息解析、等待、取消、patch 与审核后清理，不使用旧 grok-worker 生命周期。
- 显式 `--dangerously-skip-permissions` 映射为 Grok 原生 `bypassPermissions + --always-approve`，不改全局设置。原生登录、Skills、MCP 与插件照常加载。
- 为任务分配唯一原生 session ID，续聊精确 resume；清理仅删除分配的本地会话，不删除共享或远程历史。未知 reasoning token 不推算。
- 验证：完整回归 149/150，唯一失败为原版本同样复现的固定 300ms 取消时序用例；最终定向测试 26/26。真实 Grok 4.6 xhigh 工作树实现和同会话追修均成功，最终 9 项任务测试及宿主独立输入检查通过。

## v0.3.2 - 2026-09-05

- macOS dispatch/continue 继承原生全局权限偏好：Agy `toolPermission=always-proceed` 或 Claude `permissions.defaultMode=bypassPermissions` 时显式传入 `--dangerously-skip-permissions`。只对明确选择此设置的机器生效，不改变其他安装的默认权限。
- 实际参数写入 `backendArgs`，Agy/Claude 的 diagnose 明确报告 bypass；旧 run 续跑也会读取当前全局设置。Pi 不接受该参数，保持原生无审批层的行为。
- 全权限模式不提供强制文件写入隔离；任务范围和审核后清理仍保留。模式不会自动解决系统文件权限、登录失效或服务端拒绝。
- 本机验证：146/146 回归通过；三后端真实 Node 写入并读取任务全部成功且无权限拒绝，Agy 15.8s、Claude 18.9s、Pi 7.0s（小型权限冒烟，不是性能排名）。

## v0.3.1 - 2026-09-05

- **按需只读诊断 (`subworker diagnose`)**：新增只读 `diagnose --run-id ID...` 命令，输出记录中的版本、模型、进程存活、工作目录、错误和建议；未记录的信息保持未知。不调和运行状态、不全盘扫描。区分任务缺失、元数据损坏与不可读取。
- **结构化原生重试建议与计数**：保留结构化 `retryGuidance`（kind, action, retryOwner, message）并字段脱敏；`providerRetryCount` 仅反映真实记录（未记录时保持 `null`，不混淆或猜测无关重试次数）；不引入自动重试、模型/Provider 切换或新生命周期限制。
- **可选无工具进展提醒**：支持长任务可选进展提醒（`write`/`in-place` 模式默认 600 秒，`read` 模式及显式关闭为 0 秒），作为软提醒通知，不强杀任务。
- **续跑与测试修正**：续跑清空旧耗时与重试建议，并记录实际运行时版本；测试夹具清除继承的运行目录变量，避免写入正式任务目录。补齐 `steer`、`cancel` 的宿主调用说明。
- **本机验收**：macOS 144/144 项测试通过；相同写入冒烟中 Pi 16.2s、Claude 22.5s、Agy 35.8s，Root 分别复核 6/6 项冻结测试。耗时为任务端到端时间，不是启动时间。实现阶段使用正式 0.3.0，最终冒烟使用 0.3.1。

## v0.3.0 - 2026-09-05

- **多执行器统一编排与实测验收**：Root 最终验收全量通过 macOS 113/113 项测试；同题真实写任务（4 项断言）三执行器全部通过：Pi CommandCode DeepSeek Flash Max 8.7s、Claude CommandCode Muse Spark 1.3 Contributor Max 16.6s、Agy 3.8 Flash High 19.2s。
- **品牌与入口收敛**：公开品牌与 Skill 名称统一为 **Subworker**（唯一安装位置为 `~/.codex/skills/subworker`）；旧 `pi-worker` 命令路径仅作为薄转发层（thin forwarder），不保留第二个旧 `SKILL.md`；不向 GitHub 远端虚报已发布。
- **启动器解析与安全**：macOS 唯一官方入口为 `macos/bin/subworker`。编排子命令严格校验，未知命令或拼写错误直接退出码 2 并报错，杜绝 typo 降级误启；显式子命令 `subworker exec ...` 与 `subworker raw ...` 仅用于非交互式无头裸 Pi（headless bare Pi），脱离调度生命周期。
- **Agy 后端增强**：自动为 workdir 附加 `--add-dir` 避免多路径工作区逃逸；权限模式统一为 `accept-edits`；支持 `--effort`（High/Medium/Low，无 Max）并保持 24 小时 internal print wait 消除 5 分钟超时限制。
- **Claude 桥与协议健壮性**：切换为真实上游 SSE Claude 桥，支持交错工具调用（interleaved tools）、客户端断开即时中止（abort on disconnect），并完整保留输入及缓存计量（input/cache accounting）；畸形协议、null 或回调异常会立刻终止所持进程并收敛为失败结果。
- **并发等待与多会话告警**：修复 `SIGUSR1` 启动与退出时的等待竞态（wait races）；引入 `--consumer <id>`（默认 `$CODEX_THREAD_ID` 或 `default`）实现会话级独立告警回执（per-consumer alerts），多会话并发等待互不覆盖。
- **通知机制解耦**：明确启动静默 `--startup-attention`（默认 60s 首事件前软提醒）与运行期静默 `--silent-reminder`（默认 600s 无新活动软提醒，收到新事件自动重置）；两者均设 `0` 关闭，绝不作为任务硬性取消。
- **环境与平台边界**：公开规范环境变量采用 `SUBWORKER_*`，旧 `PI_WORKER_*` 保持兼容输入；`pi-worker/runs` 存储目录保留以兼容既有任务；明确 macOS write 模式携带 staged、unstaged 及未忽略 untracked 脏基线，read 模式允许受约束 bash，Windows 原有干净 HEAD 检查与 bash 禁用逻辑保持不变。

## v0.2.2 - 2026-09-04

- macOS runtime 新增 `--backend claude`，直接消费 Claude Code stream-json，保存真实 session ID、tool/usage/terminal 状态并支持同 run `continue`。
- Claude 支持当前用户 native 配置，以及 CommandCode `deepseek/deepseek-v4-flash` Max；后者让 Claude 保持 Anthropic Messages 输入，再由仅监听本机回环的无依赖桥转换到 CommandCode Chat Completions。
- CommandCode Key 只从 Pi `auth.json` 在 launcher 内存读取，不进入 prompt、result、日志或全局 Claude 设置；本次命令级 `--settings` 避免 `~/.claude/settings.json` 覆盖路由。
- read/write 默认分别使用 Claude `plan`/`auto`。权限拒绝立即发 attention；默认禁止内部 Agent/Task/Workflow 编排，显式 `--allow-orchestration` 才开放。
- 修复 Claude 可能返回 `subtype=success` 但 `is_error=true` 时被误报成功的问题；错误文本、部分输出、缓存 usage 和工具统计保留用于审核。

## v0.2.1 - 2026-09-04

- macOS attention 改为最多 8 条不同事件的有界队列；每条独立确认，后续不同故障不再被首条遮住，终态通知也不会删除已投递回执并重复告警。
- 默认在 backend 启动后 60 秒仍未收到任何 stdout/stderr 事件时发出 `startup_silent` 软提醒；任务继续运行，不构成 idle/hard timeout，可用 `--startup-attention 0` 关闭。
- 高频流式活动按 250 ms 合并持久化，工具边界、状态变化、attention 和终态仍立即落盘；减少长任务对 `result.json` 的重复原子写入。
- 成功、失败或取消收口时清理本轮进程组中仍存活的后台后代，避免测试服务器或辅助进程残留并阻塞输出管道关闭。
- macOS 启动器优先使用显式 `PI_WORKER_NODE_BIN` / `PI_WORKER_PI_BIN`，其次使用已验证的本地固定路径，最后回退到 `PATH`，升级后不再因单一路径变化直接 `command not found`。
- Agy 若返回 `SUCCESS` 但最终文本为空且包含 `denied_actions`，不再只报模糊的 `empty_final`；结果明确失败为权限拒绝并立即发出 `permission_denied` attention。
- Agy `The stream was interrupted` 错误归入 transport attention；已产生的部分文本继续保留，但 ERROR 终态不会被伪装为成功。

## v0.2.0 - 2026-09-04

- macOS runtime 新增 `--backend agy`，直接消费 Agy 1.1.8+ 的 `init`、`step_update`、`result` stream-json 事件；Pi 保持兼容默认。
- Agy 与 Pi 共用现有 detached worktree、脏基线携带、事件优先 wait、cancel、patch、review-gated cleanup、共享依赖缓存和紧凑 result，不引入第二套 job/state/wait。
- Agy `conversation_id` 支持同 run 续跑；模型、effort、usage、structured output 与终态状态进入统一结果。
- Agy 的 `ERROR` 即使带部分 response 也明确失败；认证、限流、5xx、传输和裸 `EOF` 可即时诊断。默认不设置五分钟任务寿命，也不默认全工具自动批准。
- Seatbelt 内的 review cleanup 不再遍历并尝试删除宿主共享缓存；缓存 GC 动作收据改为计数加最多 12 条样本，避免权限失败生成数万 Token 输出。

## v0.1.16 - 2026-08-29

- macOS 事件等待者与 attention 消费收据改存系统临时事件目录，持久运行目录只读时不再因创建 `waiters` 失败。
- 只有连续三次相同工具错误才触发 `repeated_tool_errors`；不同的负向测试或格式探测仍计数，但不再误唤醒 Root。
- 捕获候选补丁前删除本轮新建的 Python 字节码、测试缓存和 egg-info；源码与锁文件保持原样。

## v0.1.15 - 2026-08-29

- macOS Worker 运行状态改存到持久化 Application Support 目录，避免系统临时目录清理导致审核前结果消失。
- `wait` 默认返回紧凑 receipt，并提供 `--full` 获取完整终态；完整 `result.json` 保持不变。
- `status` 对不存在或已被清理的 run 明确返回 `state: "missing"`。

## v0.1.14 - 2026-08-27

- 移除 macOS Pi Worker 中 ShuaiAPI 的默认 Profile 与活动命令示例，避免已删除 Provider 继续出现在 `profiles` 输出中。
- 默认 Profile 改为当前可用的 AHZM GLM、CommandCode GLM/DeepSeek/Gemini、OpenCode Go DeepSeek、DeepSeek 官方与 xAI Grok；调用方仍可显式覆盖合法思考强度。

## v0.1.13 - 2026-08-27

- macOS write 模式明确接受 staged、unstaged 和非忽略 untracked 基线，调用方不再执行 clean-tree 启动门禁。
- 模型 Profile 只提供默认思考强度，不再覆盖或拒绝调用方传入的合法 Pi 强度。
- 保持 `find` 默认禁用：真实双路写任务确认其在离线环境会因缺少 `fd` 必然失败，文件搜索继续使用 `grep`/`bash`。网络沙箱快速失败、独立 worktree、审核后清理和 20 GiB 共享缓存边界保持不变。
- 显式选择 Provider 时按需加载用户级同名 Provider 扩展，修复 CommandCode 等扩展型 Provider 在临时 Profile 中启动前消失的问题。

## v0.1.12 - 2026-08-12

- 移除 `krill/grok-4.5` 与 `krill-sol/gpt-5.6-sol` Profile、示例和测试引用。
- Pi 用户配置中的对应 Provider 与凭据由安装侧同步删除；其余 Provider 不变。

## v0.1.11 - 2026-08-10

- `status` 增加 `activitySeconds`、`firstToolAt`、`lastToolAt` 和 `lastEventType`，避免把 `waiting_model` 误判为仓库读取或工具进展；续跑会清零上一轮实时计数。
- OpenCode Go DeepSeek 固定为 Max；调用方显式传入其他有效强度时，runtime 仍只向 Pi 传递 Max。
- 默认工具列表不再暴露离线 runtime 无法安装 `fd` 时必然失败的 Pi `find` 工具；`bash` 与 `grep` 继续覆盖文件搜索。

## v0.1.10 - 2026-08-10

- `dispatch/continue` 检测到 Codex Seatbelt 禁止网络时立即以明确提示退出，不创建 run、worktree 或三次无效 Provider 重试；调用方必须使用 `sandbox_permissions="require_escalated"`。
- 非平凡任务提示改为从文件读取后作为单一参数传入，避免反引号、`$()` 等 shell 语法篡改提示或产生启动错误。

## v0.1.9 - 2026-08-10

- Headless Worker 默认从任务点名的文件、失败测试和直接调用者开始，避免无依据的全仓扫描；只有任务明确要求或定向证据不足时才扩大范围。
- 纯输出和连通性检查不再调用工具。真实 Heban 目录探针从此前 50–228 秒、5–7 次工具调用降为 3.4 秒、0 次工具调用；定向读取和显式全目录搜索仍分别只调用一次 `read` 和 `grep`。

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
