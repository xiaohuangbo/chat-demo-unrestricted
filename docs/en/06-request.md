## 6. What the request actually contains

A normal request (all switches at defaults):

```json
{
  "model": "deepseek-flash",
  "system": "该助手为DeepSeek，由深度求索公司创造。",
  "messages": [
    { "role": "latest_reminder", "content": "2026-11-14,Saturday,Beijing,Web,中文" },
    { "role": "user", "content": "Hello" }
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

(`title` appears only while the conversation has no title yet, `thinking` follows the DeepThink toggle, and `max_tokens` appears only when set.)

`latest_reminder` is a strictly validated extension role with three hard rules: its content is exactly five comma-separated parts (`<date>,<weekday>,<location>,<platform>,<language>`), no field may contain a comma or newline (commas in a location are folded to spaces), and it must be followed immediately by a `user` message. A historical reminder snapshot is inserted only when it changes, always before its `user`; a first turn that also generates the title still sends it. The compression summary is also a `latest_reminder` and is merged with the round reminder that follows, so two reminders are never adjacent. "Inject the system prompt every round" never writes into this field — it appends to the end of `system` instead.

With custom chain of thought enabled, `system` gains a `[CUSTOM CHAIN OF THOUGHT]` block between the Persona / unrestricted rules and the memory / search context; with deep thinking on it becomes `[CUSTOM CHAIN OF THOUGHT · EXPERIMENTAL]`. The first request also carries `title`, and still gets the block; every other field and the message structure stay unchanged. With deep thinking off, the client additionally renders an “Injected chain of thought” card above the reply; the card is not part of the request and is not written into `blocks`.

With search poisoning enabled and takeover active, `tools` only keeps `deepseek_read_url`, `system` gains a `[LOCAL SEARCH LAYER]` block, and `latest_reminder` uses the custom date and location; with takeover off or no custom results the real-search request above is unchanged.

Attachment poisoning changes only the uploaded file bytes sent to the Files API, not the request shape; attachments are still referenced by `file_id`.

With browser tools or the workspace enabled, `tools` gains client tool definitions (name, description, input schema). When the model answers with `tool_use`, the page executes it locally and appends the result as a `tool_result` before the next request:

```json
{
  "tools": [
    { "type": "deepseek_read_url", "name": "deepseek_read_url" },
    {
      "name": "get_weather",
      "description": "Query city weather (Open-Meteo, no API key).",
      "input_schema": { "type": "object", "properties": { "location": { "type": "string" } } }
    }
  ],
  "messages": [
    { "role": "latest_reminder", "content": "2026-11-18,Tuesday,Beijing,Web,Chinese" },
    { "role": "user", "content": "Is it hot in Hangzhou today?" },
    {
      "role": "assistant",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_1",
          "name": "get_weather",
          "input": { "location": "Hangzhou" }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        { "type": "tool_result", "tool_use_id": "toolu_1", "content": "Location: Hangzhou..." }
      ]
    }
  ]
}
```

The client tool round-trip cap depends on the chat mode: Chat only sends no client tools, Web agent allows 8 rounds, PTC 16 and Creator 24; each round is a separate request (billed per round). Tool calls and results are appended to the next request as `tool_use` / `tool_result`, but never become part of the replayed history, and exports do not include tool cards.

Unrestricted mode with adjusted parameters (only fields that differ are shown):

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

Only three things differ: `system` is the assembled pipeline, the whole `safety_check` field disappears, and the sampling parameters appear. `tools`, `thinking`, `latest_reminder`, and `title` are not affected by these switches.

---

---

[← 返回 README](../../README.md) · [全部文档](README.md)

### 6.1 Request shape of the prompt-injection tool

With the prompt-injection tool enabled and forced tool choice on, `tools` carries the custom definition besides the server read-link tool, plus `tool_choice`:

```json
{
  "tools": [
    {
      "name": "emit_answer",
      "description": "Put your whole answer into the content argument…",
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

The server rejects `tool_choice` together with deep thinking, `safety_check`, server tools (`deepseek_read_url` / `deepseek_web_search`) or `title` as “thinking mode”, so forced mode turns thinking off, skips the title and drops the safety check and web tools for that round — which is why the tool suits plain text conversations.

When the `tool_use` arrives, the client restores the `content` argument as the answer body, executes nothing and sends no `tool_result` round. History is restored by rule: assistant messages can become `tool_use` (only from this tool / every answer / never) and the following question becomes its `tool_result` (all / only marked), always adjacent, with no reminder in between.
