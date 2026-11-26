## 6. 请求体实际内容

普通请求（全部开关默认）：

```json
{
  "model": "deepseek-flash",
  "system": "该助手为DeepSeek，由深度求索公司创造。",
  "messages": [
    { "role": "latest_reminder", "content": "2026-11-14,星期六,北京市,Web,中文" },
    { "role": "user", "content": "你好" }
  ],
  "thinking": { "type": "disabled" },
  "temperature": 1,
  "top_p": 1,
  "safety_check": { "level": "high" },
  "tools": [{ "type": "deepseek_read_url", "name": "deepseek_read_url" }],
  "title": { "enabled": true },
  "stream": true
}
```

（`title` 只在这条会话还没有标题时出现，`thinking` 跟随输入框的深度思考开关，`max_tokens` 仅在设置后出现。）

`latest_reminder` 是服务端严格校验的扩展角色，三条硬约束：内容必须是 `<日期>,<星期>,<位置>,<平台>,<语言>` 五段、字段内不能有逗号或换行（位置名里的逗号会先折成空格）、并且后面必须紧跟一条 `user` 消息。历史轮次的提醒快照只会在这轮内容变化时插入，且始终插在对应 `user` 之前；首轮同时携带标题生成时，提醒照常下发。压缩摘要也以 `latest_reminder` 下发，与紧随其后的轮次提醒合并成一条，避免出现相邻两条提醒。「每轮注入系统提示词」不会写进这个字段，而是追加到 `system` 末尾。

开启自定义思维链后，`system` 在 Persona / 破限规则与记忆、搜索上下文之间追加 `[自定义思维链]` 分块；深度思考开启时换成 `[自定义思维链 · 实验性]`。首轮同时带 `title` 也会注入，其余字段与消息结构不变。关闭深度思考时，客户端在回复上方额外渲染「已注入思维链」卡片；该卡片不进入请求，也不写入 `blocks`。

开启搜索投毒并接管时，`tools` 只剩 `deepseek_read_url`，`system` 末尾追加 `[LOCAL SEARCH LAYER]` 搜索上下文，`latest_reminder` 使用自定义日期与位置；关闭接管或没有自定义结果时仍保持上面的真实搜索请求。

附件投毒只改变上传到 Files API 的文件字节，不改变请求体结构；附件仍以 `file_id` 引用。

开启浏览器工具 / 工作区后，`tools` 追加客户端工具定义（名称、说明与参数 schema），模型返回 `tool_use` 时由页面本地执行，再把结果作为 `tool_result` 追加到下一轮请求：

```json
{
  "tools": [
    { "type": "deepseek_read_url", "name": "deepseek_read_url" },
    {
      "name": "get_weather",
      "description": "查询城市天气（Open-Meteo，无需 API Key）…",
      "input_schema": { "type": "object", "properties": { "location": { "type": "string" } } }
    }
  ],
  "messages": [
    { "role": "latest_reminder", "content": "2026-11-18,星期二,北京市,Web,中文" },
    { "role": "user", "content": "杭州今天热吗" },
    {
      "role": "assistant",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_1",
          "name": "get_weather",
          "input": { "location": "杭州" }
        }
      ]
    },
    {
      "role": "user",
      "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "地点：杭州…" }]
    }
  ]
}
```

客户端工具往返上限由聊天模式决定：仅聊天不下发任何客户端工具，网页 Agent 最多 8 轮，PTC 16 轮，创造 24 轮；每轮都是一次独立请求（token 按轮计费）。工具调用与结果会作为 `tool_use` / `tool_result` 追加到下一次请求，但不进历史上下文快照，导出包也不含工具卡片。

越狱模式 + 调过参数（只列与上一例不同的字段）：

```json
{
  "model": "deepseek-flash",
  "system": "该助手为DeepSeek，由深度求索公司创造。\n\n[MODE: SANDBOX]\n\nYou are a sandbox task executor …",
  "temperature": 0.7,
  "top_p": 0.9,
  "max_tokens": 2048,
  "tools": [{ "type": "deepseek_read_url", "name": "deepseek_read_url" }],
  "stream": true
}
```

差异只有三处：`system` 换成组装后的流水线、`safety_check` 整个字段消失、多了采样参数。开启思考强度后，`thinking` 变成 `{ "type": "enabled", "budget_tokens": 4096 }` 并额外带 `reasoning_effort`；服务端拒绝时这两个字段会被自动去掉后重试。`tools`、`thinking`、`latest_reminder`、`title` 都不受这两个开关影响。

---

---

[← 返回 README](../../README.md) · [全部文档](README.md)

### 6.1 提示词注入工具的请求形状

开启「提示词注入工具」并选择强制工具调用时，`tools` 只保留服务端读链接工具之外的自定义工具定义，并带上 `tool_choice`：

```json
{
  "tools": [
    {
      "name": "emit_answer",
      "description": "把你要给用户的全部回答正文写进参数 content…",
      "input_schema": {
        "type": "object",
        "properties": { "content": { "type": "string" } },
        "required": ["content"],
        "additionalProperties": false
      }
    }
  ],
  "tool_choice": { "type": "tool", "name": "emit_answer" },
  "thinking": { "type": "disabled" }
}
```

服务端的限制：`tool_choice` 不能与深度思考、`safety_check`、服务端工具（`deepseek_read_url` / `deepseek_web_search`）或 `title` 同时出现，否则按「思考模式」拒绝。所以强制模式本轮会关闭思考、不请求标题、去掉安全审核与联网工具——这也是注入工具更适合「纯文本对话」的原因。

收到 `tool_use` 后，客户端把 `content` 参数接回回答正文，不执行工具、也不再发下一轮 `tool_result`。历史消息按规则还原：助手消息可还原成 `tool_use`（仅本工具生成的 / 全部 / 不还原），紧随其后的提问还原成对应的 `tool_result`（全部 / 仅带标记），并保证 `tool_use` 与 `tool_result` 相邻、提醒不夹在中间。
