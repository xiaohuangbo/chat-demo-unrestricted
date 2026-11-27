<p align="center">
  <img src="./brand.png" alt="在这个客户端中，有无数的天才想要在肥鱼图标里，证明自己是天才。可是在带锁图标里，天才只是门槛。" width="49%"><img src="./brand_2.jpg" alt="你应该放弃这世间所有的C端客户端，来体验宇宙最强对抗路神作，这是你唯一和顶级开源模型厮杀的机会" width="49%">
</p>

<h1 align="center">deepseek unrestricted chat harness</h1>

<p align="center">
  deepseek unrestricted chat harness —— 基于 DeepSeek API 的静态聊天前端，带解除限制模式、回复改写与参数直调<br>
  <a href="./README.md">English</a> | 简体中文
</p>

> 本项目是官方示例 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 的**非官方修改版**（fork），MIT 许可。
> 所有改动都在浏览器里完成：请求体怎么拼、回复怎么存、界面怎么显示。没有代理、没有中转服务，
> API Key 与对话记录仍只保存在你自己的浏览器里。
>
> 🔗在线版：<https://chat-unrestricted.fur0.com/>
>
> 📦仓库：<https://github.com/xiaohuangbo/chat-demo-unrestricted>
>
> 🎥介绍视频：<https://www.bilibili.com/video/BV1m3s66WESg/>
>
> 📚参考论文：<https://arxiv.org/pdf/2403.12171>

<p align="center">
  <img src="./Demo%20Picture.png" alt="聊天界面演示：解除限制模式下的技术问答" width="860">
</p>

---

## 本仓库新增了什么

- **解除限制与提示词工程**：越狱模式、系统提示词预设、每轮注入、中文越狱提示词、自定义思维链；
- **浏览器 Agent 工具**（默认关闭，逐项开关）：时间、定位、天气、通知、剪贴板、抓网页、生成文件、打开链接、可视化组件、GenUI 界面（JSON 声明，原生渲染指标卡 / 表格 / 图表）、提示词注入工具（自定义工具名与参数，强制 `tool_choice` 让模型把正文写成参数，客户端再还原）与它配套的历史消息工具调用转换；
- **虚拟工作区**：浏览器本地文件库，任意格式导入导出、OPFS 真文件系统、安卓端为应用存储；
- **NanoVM Slim**：内置 WASM Shell Engine 与 130 个 busybox 命令，支持从本机或工作区直接导入单个文件（含 zip / 二进制，另有 `nanovm_import` Agent 工具），并新增 PyBot 工具链（64 万行纯 Python 规则聊天机器人，无模型权重），桌面端右侧停靠、手机端底部面板，Python / Node / Lua / SQLite / esbuild / tsc / Sass / Terser / Prettier / make / Git 按需安装，虚拟机内自带虚拟网络（Node 与 Python 的 HTTP / WebSocket 服务）；
- **WebVM（CheerpX）**：第二个终端跑真正的 x86 Debian 10，自带 bash / gcc / g++ / Python 3 / Node.js / Ruby / Lua / make / git / vim；与 NanoVM 同时运行、自由切换，支持导入导出与模型调用，磁盘改动写进 IndexedDB 覆盖层；
- **Unkernel Linux**：第三个虚拟机，跑真正编译成 WebAssembly 的 Linux 7.x 内核——Alpine 3.24 / Debian 13、`apk` / `apt`、bash、SMP 多 CPU、Wisp 联网（默认公共 anura.pro / mercurywork.shop 代理）、Web Audio 声音、framebuffer/evdev 显示、IndexedDB 持久磁盘（设置里可扩容、可重置）、文件导入导出，页面界面已汉化；新版页面是桌面（窗口 / 程序坞 / 应用启动器 / 控制中心 / 预览浏览器 / Wayland 窗口），80+ 个开箱应用（Steam、Chromium / Firefox / Ladybird、VLC / mpv、Xfce / X11、Vulkan、Claude Code / Ollama、Node / Python / Go / Rust、nginx / PostgreSQL、Ubuntu chroot 与 box64 等）首次运行按需下载并装包；聊天工作区挂到 `/mnt/workspace`，模型可用 shell、列目录、读写文件、工作区互传、Python、系统信息、打开、重启、状态共十个 `unkernel_*` 工具；启动器「AI」文件夹内置 **DSH go**——24 MiB 的 Go 单文件 DeepSeek Harness，自带中文 REPL 和可用的 `bash` 工具，不需要 Node.js 和几百 MB 的运行时；NanoVM / WebVM 新增 `fastfetch`；
- **聊天模式**：仅聊天 / 网页 Agent / PTC / 创造，决定下发哪些客户端工具与往返上限；
- **关键词拒答**：设置 → 模型里配置关键词、大小写与自定义话术，命中用户输入时本地直接拒答，不请求接口，未填 API Key 也能触发；
- **统计与计费**：用量账本、上下文分类、按模型计费、服务端搜索免费开关；
- **应用内文档**：侧栏 NanoVM Slim 上方内置「文档」页，26 个小节讲清设置、模式、破甲、附件、记忆、虚拟机与术语，其中「解码与采样参数」逐项解释温度、Top P、max_tokens、思考预算与惩罚项，「Token、上下文、缓存与压缩」讲清计费与窗口；左侧目录 + 蓝色页内链接，手机端目录折叠、表格横向滑动，中文 / English 跟随界面语言切换；
- **安卓端**：APK 构建、应用内更新检测、NanoVM 联网内置代理；WebVM 因 Android WebView 不支持跨源隔离而只能在浏览器里运行，Unkernel 在 WebView 支持 JSPI 时可直接使用。

## 文档导航

README 已经拆成 `docs/zh/` 下的分册，首页只保留简介与入口；英文文档在 [`docs/en/`](docs/en/README.md)。

> 应用内也内置了同主题的「文档」页（侧栏 **NanoVM Slim** 上方），支持中英文、目录与页内跳转，适合手机端随时查阅。

| 章节                  | 内容                                                    | 文件                                                   |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| 1. 这是什么           | 项目定位、原版功能与本仓库新增的能力清单                | [01-what-is-this.md](docs/zh/01-what-is-this.md)       |
| 2. 原版做了哪些限制   | 请求侧与界面侧被写死的地方                              | [02-original-limits.md](docs/zh/02-original-limits.md) |
| 3. 本仓库做了哪些改动 | 3.1–3.53：设置页每一组功能、NanoVM Slim、WebVM、Unkernel、聊天模式与各轮修复的细节 | [03-changes.md](docs/zh/03-changes.md)                 |
| 4. 行为对照表         | 原版 / 默认 / 越狱模式逐项对比                          | [04-behaviour.md](docs/zh/04-behaviour.md)             |
| 5. 设置项速查         | 每一项的默认值与 localStorage 键名                      | [05-settings.md](docs/zh/05-settings.md)               |
| 6. 请求体实际内容     | 实际发出去的 JSON 长什么样                              | [06-request.md](docs/zh/06-request.md)                 |
| 7. 实现位置索引       | 每个能力对应的源码文件                                  | [07-implementation.md](docs/zh/07-implementation.md)   |
| 8. 数据、隐私与网络   | 数据都存在哪、请求发往哪里                              | [08-privacy.md](docs/zh/08-privacy.md)                 |
| 9. 运行与构建         | 开发、构建与 Android APK 打包                           | [09-build.md](docs/zh/09-build.md)                     |
| 10. 已知限制          | 87 条边界与取舍                                         | [10-known-limits.md](docs/zh/10-known-limits.md)       |
| 11. 许可与致谢        | MIT 许可与上游                                          | [11-license.md](docs/zh/11-license.md)                 |

## 快速开始

```sh
pnpm install
pnpm dev                       # 本地开发（http://localhost:8090）
pnpm build                     # 构建静态产物到 dist/
KS_PASS=<keystore密码> ./构建APK.sh   # 构建并签名 Android APK
```

完整说明（环境变量、签名、字体与离线细节）见 [9. 运行与构建](docs/zh/09-build.md)。

预构建产物：[GitHub Releases](https://github.com/xiaohuangbo/chat-demo-unrestricted/releases) — `deepseek-unrestricted-2.7.20.apk`（118 MB，versionCode 290，
SHA-256 `b6e4678f85fcb3e40bea95b894e7f05dee1c82f399bfae1a0dc4d111ba6d1b4c`），详情见 [android/README.md](android/README.md)。APK 作为 Release 资产分发，不进 Git（GitHub 拒绝超过 100 MB 的文件）。
注意：Android WebView 没有 WebGPU，浏览器内 WebLLM 模型只能在桌面浏览器使用；APK 内请改用 MLC-LLM API。

## 兼容性

最近一次兼容性回归（2026-11，v2.7.20，`compat` / `compat-prod` 两套矩阵）：

| 范围            | 覆盖                                                       | 结果  |
| --------------- | ---------------------------------------------------------- | ----- |
| 浏览器          | Chromium、Firefox                                          | 13/13 |
| 视口            | 320 / 390 / 768 / 1024 / 1440 / 1920                       | 13/13 |
| 主题与语言      | 明 / 暗、zh-CN / en-US                                     | 13/13 |
| 生产静态构建    | `dist/` 产物跑同一套用例                                   | 13/13 |
| NanoVM / 工具链 | 终端、配额、工具调用、11 条工具链、虚拟网络                | 21/21 |
| WebVM / CheerpX | 跨源隔离、启动、xterm 输入、滚动、导入导出、切换、Agent 工具 | 通过  |
| 关键词拒答      | 开关、大小写、无 Key 本地回复、不请求接口                   | 通过  |
| 聊天模式        | 仅聊天 / 网页 Agent / PTC / 创造 的工具分组与往返上限      | 10/10 |
| 提示词注入工具  | 强制 `tool_choice`、正文还原、历史 `tool_use` / `tool_result` 转换、关停与仅聊天模式 | 通过  |
| 记忆节点        | 关键字 / 标签筛选、就地编辑、标签边重算、390px 布局        | 通过  |
| Unkernel 新页面 | 桌面启动、应用启动器、DSH go 安装运行、宿主设置映射 `datasize`、工作区挂载、Agent 工具 | 通过  |
| 移动端布局      | 320 / 360 / 390 / 414 / 599 / 767 与桌面 768 / 1024 / 1440 | 49/49 |
| 安卓 APK        | Android 14 WebView（320dp）：启动、终端、虚拟网络、控制台；WebVM 受 WebView 跨源隔离限制 | 通过  |
| Unkernel Linux  | iframe 启动、新版桌面与 80+ 应用启动器、Alpine / Debian、2 CPU SMP、工作区挂载/写回、文件导入/导出、设置页与 `datasize` 映射 | 通过  |
| 会话置顶 / 多选 | 「…」逐个置顶、置顶分组与图钉、刷新后仍生效、多选头部计数、批量置顶、批量删除确认、390px 抽屉 | 通过  |
| Unkernel 联网   | Debian `apt-get update`（10.2 MB 索引）/ `apt-get install bzip2`、Alpine `apk update` / `apk add curl`、guest HTTP 200、`routes=0` 与内存交回页面 | 通过  |
| Upstream 0.1.4  | 归档附件随会话导入、按对话计进度、旧浏览器 AbortSignal / toSorted / 100dvh 兼容 | 通过（真机导入 3000 会话、带图归档、旧内核构建验证） |

浏览器与桌面/移动端的边界、已知取舍见 [10. 已知限制](docs/zh/10-known-limits.md)。

## 最近版本

- **2.7.20**：两个新功能（另附一次图标修缮）。① 会话列表支持置顶与多选：「…」菜单可逐个置顶（置顶的会话进「置顶」分组并带图钉），「多选」进入勾选模式后头部显示「已选择 N 个对话」、可全选，底部给出「置顶 / 删除」操作条，删除前确认数量；置顶标记随会话保存（刷新与重开浏览器后仍在；导出为 DeepSeek 历史格式不带置顶，导入后需重新置顶）。②「恢复默认设置」改为联动所有 store：设置项、提示词预设、本地模型偏好（并卸载模型）、NanoVM / WebVM / Unkernel 参数一起回默认，API Key、对话、附件、工作区、记忆库与统计保留；确认弹窗明确列出「会重置 / 会保留」。置顶图标换成 Material 的 `push_pin` 标准图钉（原来手绘路径在 16px 下糊成一团色块）。

- **2.7.19**：两处 Unkernel 修复。① 设置 → Unkernel Linux 去掉「内核内存」滑块：上游页面自己的「设置 → 机器」里就有内存（带按设备算出的自动值），而宿主传的 `?mem=` 会把内存钉死并在每次启动时覆盖页面里的改动，现在内存只由虚拟机自己的设置决定（`kw.settings`），宿主面板保留发行版、数据盘、CPU、设备、Worker、Wisp 与超时。② 修复 Debian 里 `apt-get update` / `apt-get install` 的 403：新版页面默认把 `deb.debian.org` 等纯 HTTP 交给自己的 CORS 镜像 `mirror.unkernel.dev` 代答，而该镜像只接受 `https://unkernel.dev`、`http://localhost:*` 等白名单源，本应用跑在 `127.0.0.1:3080`、局域网地址或 APK 的 `http://127.0.0.1:18765` 上只会拿到 `403 Origin not allowed`（官方站没有这个问题就是因为它的源在白名单里）；现在 iframe 固定带 `routes=0`，guest 的纯 HTTP 也走 Wisp，实测 Debian 的 `apt-get update` 拉完 10.2 MB 索引、`apt-get install bzip2` 正常，Alpine 的 `apk` 与 HTTP 访问也正常。

- **2.7.18**：文档全面修订。README、`docs/zh|en/` 11 篇分册与应用内文档同步到 2.7.17 的实际能力（GenUI、提示词注入工具、记忆节点筛选与就地编辑、新版 Unkernel 桌面页面），修掉过期的版本号（仍写着 2.7.9）、工具数量（十项 / 十个）、章节范围（3.1–3.39）与 APK 体积（112 MB）；设置项速查补齐提示词注入、记忆检索权重与阈值、大文本附件、主题 / 语言 / 位置等 17 个缺失的 localStorage 键；请求体文档补上 `tool_choice`、`latest_reminder` 五段式与各模式的工具往返上限；已知限制扩到 86 条，并修正 Unkernel 许可证路径与隐私章节的外部请求说明。

- **2.7.17**：修复带历史的请求被服务端拒绝的 400「a `latest_reminder` message must be immediately followed by a `user` message」——2.7.16 把历史轮次的提醒快照插到了提问之后（`user → latest_reminder → assistant`），现在提醒一律插在提问之前；压缩摘要与轮次提醒合并成一条（连续两条 `latest_reminder` 同样会被拒），注入工具的历史还原在「下一条提问前要插新提醒」时让位，避免提醒夹在 `tool_use` 与 `tool_result` 之间。同版本并入新版 Unkernel Linux 页面（上游 v0.2.0-261126）：控制台升级成桌面（窗口 / 程序坞 / 应用启动器 / 控制中心 / 预览浏览器 / Wayland 窗口），80+ 个开箱应用按需下载安装（Steam、Chromium / Firefox / Ladybird、VLC / mpv、Xfce / X11、Vulkan、Claude Code / Ollama、Node / Python / Go / Rust、nginx / PostgreSQL、Ubuntu chroot 与 box64 等），保留 DSH go（移入「AI」文件夹）与宿主设置面板，数据盘改按 `datasize` 传入，整页重新汉化。

- **2.7.16**：设置 → 浏览器工具新增「提示词注入工具（自定义）」——自己定义工具名、描述与参数名，描述里写明「把回答正文写进这个参数」；开启强制工具调用时请求带 `tool_choice` 指向它，模型只能把正文写成一次工具调用的参数，收到回应后客户端再把参数还原成普通正文，界面、复制与历史里都是正常回答；历史消息按规则还原成工具调用（助手消息转 `tool_use`：仅本工具生成的 / 全部回答 / 不转；紧随其后的提问转 `tool_result`：全部 / 仅带标记的，标记不进正文），多轮上下文与本轮形状一致，附件与系统提醒自动让位；强制模式自动处理接口限制（关闭深度思考、不请求标题、去掉安全审核字段与联网工具，否则会被当成思考模式拒绝）。同版本补丁：修复「每轮注入系统提示词」把提示词拼进 latest_reminder 导致的 400（服务端把该字段按逗号切成五段，提示词里的逗号会让后面的文字被当成平台 / 语言，现在改为追加到 system 末尾，位置里的逗号与换行也会先折平）；记忆节点列表新增筛选栏（关键字按标题 / 正文 / 标签过滤、标签按钮多选取交集、关系图淡出未命中节点）与节点就地编辑（直接改标题 / 正文 / 标签，标签改动同步重算标签边）。

- **2.7.15**：设置 → 浏览器工具新增「生成 GenUI 界面」——模型用 JSON 声明界面（指标卡 / 可排序表格 / 折线柱状图 / 进度 / 提示 / 网格卡片），客户端用白名单组件原生渲染，不执行 HTML；图标与语法参考 [dsh-genui](https://github.com/omdsh-dev/dsh-genui)（MIT），鸣谢已加到更新日志末尾。同时合并上游 chat-demo 0.1.4（`5477ea6` / `6da0786` / `ea0d208` / `cdf9617`）——导入历史时按会话配对读取附件，先读会话 JSON 再读它自己的文件，不再要求图片排在 index 之后；跨会话去重改用 ZIP 偏移、读窗口升级为双缓存；导入进度改为按对话数显示；同时兼容旧内核（AbortSignal.reason / throwIfAborted 兜底、toSorted / toReversed 替换、100dvh 回退 100vh）。

- **2.7.14**：应用内文档扩充到 26 小节，新增「解码与采样参数」（温度 / Top P / max_tokens / 思考预算 / 惩罚项 / 流式与组合速查）与「Token、上下文、缓存与压缩」，术语表补到 28 条；修复新会话第一条消息拿不到记忆的 bug——首轮同时生成服务端标题，代码误把整轮当成「标题请求」把长期记忆与网状记忆库整段跳过，检索结果从未进入 system；现在首轮照常检索并注入，`Last injected` 也会在首轮更新；同时加强记忆注入说明，要求模型直接引用这些事实、不要声称不知道。

- **2.7.13**：跟进上游历史归档导入性能优化（ZIP 读窗口与中央目录复用、JSON 流式解码、批量写暂存、只给引用图片的会话回填 MIME；3000 个会话约 1 秒，进度条与校验不变）；主界面 NanoVM Slim 上方新增「文档」——24 个小节的 wiki 式说明（设置总览、角色、工作区、语音、模式、模型参数、关键词拒答、破甲、搜索投毒、附件、记忆、虚拟机、本地模型、Agent、统计、数据、隐私、平台差异、已知限制、FAQ、术语表），左侧目录 + 蓝色页内链接与外部链接；手机端目录折叠、表格横向滑动、滚动后出现「↑ 目录」，中英文跟随界面语言。

- **2.7.12**：修复网状记忆检索对俄语（西里尔）等非拉丁文字的匹配——分词改用 Unicode 字母 / 数字（`\p{L}` / `\p{N}`），中文仍按单字 + 二元词；设置 → 记忆新增「标签关联与图扩展」开关：共享标签的节点自动连边（每节点最多 3 条），检索命中时按标签扩散，搜索调试显示「标签扩展 N」。

- 更早的版本见应用内 **设置 → 更新日志**。

## Star 历史

<!-- star-history:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/star-history/star-history-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/star-history/star-history-light.svg" />
  <img alt="Star History Chart" src="assets/star-history/star-history-light.svg" />
</picture>
<!-- star-history:end -->

## 鸣谢

- **Linux DO 社区**：<https://linux.do/> —— 感谢社区提供的交流、反馈与测试支持。
- 上游项目、参考实现与许可信息见 [11. 许可与致谢](docs/zh/11-license.md)。

## 许可

MIT，见 [11. 许可与致谢](docs/zh/11-license.md)。
