## 5. 设置项速查

| 位置       | 设置项             | 默认值                    | localStorage 键                            | 越狱模式下的表现     |
| ---------- | ------------------ | ------------------------- | ------------------------------------------ | -------------------- |
| 模型       | 温度               | `1`                       | `chat-demo:temperature`                    | 不受影响             |
| 模型       | Top P              | `1`                       | `chat-demo:top-p`                          | 不受影响             |
| 模型       | 最大输出 Token     | 空（不下发）              | `chat-demo:max-tokens`                     | 不受影响             |
| 破甲       | 防撤回             | 关                        | `chat-demo:keep-reply-content`             | 不受影响（独立开关） |
| 破甲       | 跳过安全审核       | 关                        | `chat-demo:skip-safety-check`              | 强制开启、置灰       |
| 破甲       | 拒绝后继续生成     | 关                        | `chat-demo:continue-refused`               | 强制开启、置灰       |
| 模型       | 关键词拒答         | 关                        | `chat-demo:refusal-enabled`                 | 不受影响             |
| 模型       | 拒答关键词         | 空                        | `chat-demo:refusal-keywords`                | 不受影响             |
| 模型       | 区分大小写         | 关                        | `chat-demo:refusal-case-sensitive`          | 不受影响             |
| 模型       | 自定义拒答话术     | 空（默认话术）            | `chat-demo:refusal-message`                 | 不受影响             |
| 记忆       | 自动提炼模型       | `auto`（跟随当前模型）    | `chat-demo:memory-extract-engine`           | 不受影响             |
| 角色       | 角色列表 / 人设    | 仅 DeepSeek               | `chat-demo:roles`                           | 不受影响             |
| 角色       | 会话角色           | 跟随当前角色              | 会话字段 `roleId`                           | 不受影响             |
| 通用       | 我的昵称           | `我`                      | `chat-demo:profile-name`                    | 不受影响             |
| 通用       | 我的头像           | 空                        | `chat-demo:profile-avatar`                  | 不受影响             |
| 模型       | 压缩触发阈值       | `0`（跟随上下文压力）     | `chat-demo:compress-threshold`              | 不受影响             |
| 账户与用量 | 余额查询           | ——                        | 不存储（实时请求）                          | 不受影响             |
| 本地模型   | 缓存后端           | `cache`                   | `chat-demo:local-cache-backend`             | 不受影响             |
| 本地模型   | 上下文窗口         | 跟随模型推荐值            | `chat-demo:local-context-window`            | 不受影响             |
| 本地模型   | 温度               | 模型推荐值                | `chat-demo:local-temperature`               | 不受影响             |
| 本地模型   | Top P              | 模型推荐值                | `chat-demo:local-top-p`                     | 不受影响             |
| 本地模型   | 最大输出 Token     | `2048`                    | `chat-demo:local-max-tokens`                | 不受影响             |
| 本地模型   | 存在惩罚           | `0`                       | `chat-demo:local-presence-penalty`          | 不受影响             |
| 本地模型   | 频率惩罚           | `0`                       | `chat-demo:local-frequency-penalty`         | 不受影响             |
| 本地模型   | Qwen3 思考模式     | 关                        | `chat-demo:local-enable-thinking`           | 不受影响             |
| 本地模型   | 打开页面自动加载   | 关                        | `chat-demo:local-auto-load`                 | 不受影响             |
| 本地模型   | MLC-LLM 服务地址   | `http://127.0.0.1:8000`  | `chat-demo:local-mlc-endpoint`              | 不受影响             |
| 破甲       | 系统提示词预设（多套） | 1 套（有自定义时）    | `chat-demo:system-prompt-presets`          | 不受影响             |
| 破甲       | 当前预设           | 空（自动组装）            | `chat-demo:system-prompt-active`           | 不受影响             |
| 思维链     | 思维链预设         | 1 套（当前内容）          | `chat-demo:cot-presets`                    | 不受影响             |
| 思维链     | 当前预设           | 默认预设                  | `chat-demo:cot-active`                     | 不受影响             |
| 破甲       | 解除限制模式       | 关                        | `chat-demo:unrestricted`                   | ——                   |
| 破甲       | 自定义系统提示词   | 空（自动组装）            | `chat-demo:system-prompt`                  | 覆盖自动组装结果     |
| 思维链     | 启用自定义思维链   | 关                        | `chat-demo:custom-cot-enabled`             | 不受影响             |
| 思维链     | 思维链正文         | 空                        | `chat-demo:custom-cot`                     | 不受影响             |
| 破甲       | 提示词预设（内置） | `deepseek`                | `chat-demo:prompt-preset`                  | 不受影响             |
| 破甲       | 输入扰动           | 关                        | `chat-demo:parseltongue`                   | 不受影响             |
| 破甲       | 扰动技术           | `leetspeak`               | `chat-demo:parseltongue-technique`         | 不受影响             |
| 破甲       | 扰动强度           | `medium`                  | `chat-demo:parseltongue-intensity`         | 不受影响             |
| 破甲       | 自动调参           | 关                        | `chat-demo:autotune`                       | 不受影响             |
| 破甲       | 调参策略           | `adaptive`                | `chat-demo:autotune-strategy`              | 不受影响             |
| 破甲       | 输出整形           | 空（关闭）                | `chat-demo:stm-modules`                    | 不受影响             |
| 附件       | 启用附件限制       | 开                        | `chat-demo:attachment-limits`              | 不受影响             |
| 附件       | 大文本自动分片     | 关                        | `chat-demo:attachment-large-text`          | 不受影响             |
| 附件       | 大文本直接放入上下文 | 关                      | `chat-demo:attachment-large-text-inline`   | 不受影响             |
| 附件       | 单文件大小上限     | 64 MB                     | `chat-demo:attachment-max-mb`              | 不受影响             |
| 附件       | 单会话数量上限     | 50                        | `chat-demo:attachment-max-count`           | 不受影响             |
| 附件       | 扩展名白名单       | 内置清单                  | `chat-demo:attachment-exts`                | 不受影响             |
| 输入框     | 模型               | `deepseek-flash`          | `chat-demo:model`                          | 下一条回复生效       |
| 输入框     | 思考强度           | 0（关闭）                 | `chat-demo:reasoning-effort`               | 不受影响             |
| 输入框     | 自动越狱           | 关                        | `chat-demo:auto-jailbreak`                 | 不受影响             |
| 实验台     | 变体赛跑预算       | 1 元                      | `chat-demo:variant-race-budget`            | 不受影响             |
| 实验台     | 变体赛跑确认已关闭 | 关                        | `chat-demo:variant-race-confirm-dismissed` | 不受影响             |
| 破甲       | 每轮注入系统提示词 | 关                        | `chat-demo:inject-prompt-every-turn`       | 不受影响             |
| 破甲       | 历史思维链伪装     | 关                        | `chat-demo:thinking-as-body`               | 不受影响             |
| 模型       | 流式输出           | 开                        | `chat-demo:stream-output`                  | 不受影响             |
| 通用       | 主题               | 跟随系统                  | `chat-demo:theme-preference`               | 不受影响             |
| 通用       | 语言               | 跟随浏览器                | `chat-demo:locale`                         | 不受影响             |
| 通用       | 位置信息           | 空                        | `chat-demo:location`                       | 不受影响             |
| 通用       | 朗读音色           | `stella`                  | `chat-demo:tts-voice`                      | 不受影响             |
| 通用       | 侧边栏收起         | 关                        | `chat-demo:sider-collapsed`                | 不受影响             |
| 模型       | 深度思考           | 关                        | `chat-demo:thinking`                       | 不受影响             |
| 模型       | 智能搜索           | 关                        | `chat-demo:search`                         | 不受影响             |
| 数据管理   | API Key            | 空                        | `chat-demo:api-key`                        | 不受影响             |
| 模型       | 自动压缩长对话     | 关                        | `chat-demo:auto-compress`                  | 不受影响             |
| 搜索投毒   | 启用搜索投毒       | 关                        | `chat-demo:search-poison`                  | 不受影响             |
| 附件       | 启用附件投毒       | 关                        | `chat-demo:attachment-poison`              | 不受影响             |
| 破甲       | 中文越狱提示词     | 关                        | `chat-demo:translate-jailbreak-zh`         | 不受影响             |
| 通用       | 每日上限提醒       | 关                        | `chat-demo:daily-limit-enabled`            | 不受影响             |
| 通用       | 每日 Token 上限    | 1000000                   | `chat-demo:daily-token-limit`              | 不受影响             |
| 通用       | 每日费用上限（元） | 10                        | `chat-demo:daily-cost-limit`               | 不受影响             |
| 记忆       | 长期记忆           | 开                        | `chat-demo:saved-memory-enabled`           | 不受影响             |
| 记忆       | 自动提炼长期记忆   | 关                        | `chat-demo:auto-extract-memory`            | 不受影响             |
| 记忆       | 记忆更新提示       | 开                        | `chat-demo:memory-update-notice`           | 不受影响             |
| 记忆       | 网状记忆检索       | 开                        | `chat-demo:memory-bank-enabled`            | 不受影响             |
| 记忆       | 注入条数           | 4                         | `chat-demo:memory-bank-limit`              | 不受影响             |
| 记忆       | 向量维度           | 256                       | `chat-demo:memory-bank-dimension`          | 不受影响             |
| 记忆       | 检索阈值           | 0.15                      | `chat-demo:memory-bank-threshold`          | 不受影响             |
| 记忆       | 关键词权重         | 1                         | `chat-demo:memory-bank-keyword-weight`     | 不受影响             |
| 记忆       | 标签权重           | 0.5                       | `chat-demo:memory-bank-tag-weight`         | 不受影响             |
| 记忆       | 向量权重           | 0.8                       | `chat-demo:memory-bank-vector-weight`      | 不受影响             |
| 记忆       | 关联边权重         | 0.4                       | `chat-demo:memory-bank-edge-weight`        | 不受影响             |
| 记忆       | 标签关联与图扩展   | 关                        | `chat-demo:memory-bank-tag-expansion`      | 不受影响             |
| 浏览器工具 | 启用浏览器工具     | 关                        | `chat-demo:agent-tools-enabled`            | 不受影响             |
| 浏览器工具 | 单项工具开关       | 全开（随主开关）          | `chat-demo:agent-tool-flags`               | 不受影响             |
| 浏览器工具 | 提示词注入工具配置 | 工具名 `emit_answer`、参数 `content`、强制 `tool_choice` 开 | `chat-demo:custom-injection` | 不受影响             |
| 工作区     | 启用工作区         | 关                        | `chat-demo:workspace-enabled`              | 不受影响             |
| 工作区     | 工作区文件         | 空                        | `chat-demo:workspace`                      | 不受影响             |
| 工作区     | 存储方式           | `local`                   | `chat-demo:workspace-mode`                 | 不受影响             |
| 统计       | 服务端搜索免费     | 开                        | `chat-demo:server-search-free`             | 不受影响             |
| 统计       | 用量账本（自动）   | 空                        | `chat-demo:usage-ledger`                   | 不受影响             |
| 统计       | 上下文占用（自动） | 空                        | `chat-demo:context-usage`                  | 不受影响             |
| 统计       | 上下文分类（自动） | 空                        | `chat-demo:context-breakdown`              | 不受影响             |
| NanoVM     | 启用 NanoVM Slim   | 开                        | `chat-demo:nanovm-config`                  | 不受影响             |
| NanoVM     | 允许模型调用 Shell | 关                        | `chat-demo:nanovm-config`                  | 不受影响             |
| NanoVM     | 内存 / 磁盘配额    | 128MB / 64MB              | `chat-demo:nanovm-config`                  | 不受影响             |
| NanoVM     | 命令超时           | 15 秒                     | `chat-demo:nanovm-config`                  | 不受影响             |
| NanoVM     | 虚拟机文件         | 出厂目录树                | OPFS `chat-demo-nanovm`                    | 不受影响             |
| NanoVM     | 已装工具链         | Node / Git / make（内置） | `chat-demo:nanovm-packages`                | 不受影响             |
| WebVM      | 启用 WebVM         | 开                        | `chat-demo:webvm-config`                   | 不受影响             |
| WebVM      | 允许模型调用 WebVM | 关                        | `chat-demo:webvm-config`                   | 不受影响             |
| WebVM      | 打开时自动启动     | 开                        | `chat-demo:webvm-config`                   | 不受影响             |
| WebVM      | 系统镜像           | Debian 10 完整            | `chat-demo:webvm-config`                   | 不受影响             |
| WebVM      | 单条命令超时       | 30 秒                     | `chat-demo:webvm-config`                   | 不受影响             |
| WebVM      | 磁盘覆盖层（自动） | 空                        | IndexedDB `nanovm-webvm:debian`            | 不受影响             |
| WebVM      | 跨源隔离（自动）   | 未启用                    | Service Worker `coi-sw.js`                 | 不受影响             |
| Unkernel   | 启用 Unkernel Linux | 开                       | `chat-demo:unkernel-config`                | 不受影响             |
| Unkernel   | 允许模型调用 `unkernel_*` | 关                 | `chat-demo:unkernel-config`                | 不受影响             |
| Unkernel   | 发行版             | `alpine`（3.24）          | `chat-demo:unkernel-config`                | 不受影响             |
| Unkernel   | 数据盘             | 8192 MiB（8 GiB）         | `chat-demo:unkernel-config`                | 不受影响             |
| Unkernel   | 网络 / 声音 / 显示 | 开 / 开 / 开              | `chat-demo:unkernel-config`                | 不受影响             |
| Unkernel   | 持久磁盘           | 开                        | `chat-demo:unkernel-config`                | 不受影响             |
| Unkernel   | Worker / CPU       | 关 / 1                    | `chat-demo:unkernel-config`                | 不受影响             |
| Unkernel   | Wisp 地址          | 空（公共代理）            | `chat-demo:unkernel-config`                | 不受影响             |
| Unkernel   | 命令超时           | 30000 毫秒                | `chat-demo:unkernel-config`                | 不受影响             |
| Unkernel   | 内核内存（页面自己管） | 自动（手机 512 MiB、桌面 2048 MiB） | `kw.settings`（页面内设置，同一源） | 不受影响 |
| Unkernel   | 数据盘内容 / 快照  | 空                        | IndexedDB `kwdisk:kwdata`（页面）          | 不受影响             |
| DeepSeek 账号 | 登录态（Key 尾号 + 余额快照 + 登录时间） | 未登录                    | `chat-demo:account-session`                | 不受影响             |
| 会话列表   | 置顶               | 不置顶                    | IndexedDB `sessionSummaries.pinned`（随会话） | 不受影响             |
| 输入栏     | 聊天模式           | 网页 Agent                | `chat-demo:chat-mode`                      | 不受影响             |

各项值在关闭越狱模式后仍按你各自勾选的状态生效。

---

---

[← 返回 README](../../README.md) · [全部文档](README.md)
