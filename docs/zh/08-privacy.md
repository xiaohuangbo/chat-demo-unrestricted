## 8. 数据、隐私与网络

- API Key、各项设置：浏览器 localStorage（键名见第 5 节）；
- 搜索投毒配置（时间、替换 / 过滤规则、自定义结果）只存 localStorage，启用后会作为 system 上下文发送给你配置的 API 地址；
- 附件投毒配置只存 localStorage；原始附件在本机，上传的是处理后的副本，伴随文本附件会作为普通文件随消息发送；
- 会话与附件原件：IndexedDB，按浏览器用户配置与站点源隔离；
- 出站请求只有你配置的 API 地址（默认 `https://api.deepseek.com`）：`/models` 校验 Key、`/anthropic/v1/messages` 对话、`/anthropic/v1/files` 附件、ASR / TTS 语音接口；
- 浏览器工具 / 工作区：开关在 localStorage；工作区文件默认在 `chat-demo:workspace`，切到 OPFS 后改存到站点私有的 `chat-demo-workspace/` 目录（浏览器分配、其它站点无法访问）；工具结果与产物随回复写入 IndexedDB；
- 统计：`chat-demo:usage-ledger`、`chat-demo:context-usage`、`chat-demo:context-breakdown` 只存聚合数字，不含对话正文；
- 工具会向第三方服务发起请求：Open-Meteo（天气）、BigDataCloud（逆地理）、你让 Agent 抓取的网页；其余工具都在本地完成；
- Unkernel 页面在 iframe 里运行，资源随应用分发；guest 联网走 Wisp 代理（默认 anura.pro / mercurywork.shop），代理运营方能看到连接的主机名、端口与明文 HTTP 内容，TLS 仍端到端。应用的首次运行下载（Steam、浏览器、发行版软件包等）也经由页面发起：同源文件直接 `fetch()`，外站文件走 Wisp 或镜像站；
- guest 的 GL / Vulkan / VA-API 在本地渲染（WebGL2 / WebGPU / WebCodecs），画面不上传；DSH go 的 24 MiB 二进制来自本仓库，不联网下载；
- 提示词注入工具只改写请求的结构（`tools` / `tool_choice`），不增加新的出站目标；记忆节点筛选只在本地列表上过滤，不影响检索与注入；
- 没有统计、没有埋点、没有第三方脚本、没有中转服务器；
- 历史导入导出为 ZIP，导出包含会话与本地图片原件，不包含 API Key 与设置；归档格式与保留范围见[历史导入导出说明](../../src/services/chat/history/README.md)。

---

---

[← 返回 README](../../README.md) · [全部文档](README.md)
