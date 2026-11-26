## 5. Settings reference

| Group             | Setting                              | Default                      | localStorage key                           | Unrestricted mode               |
| ----------------- | ------------------------------------ | ---------------------------- | ------------------------------------------ | ------------------------------- |
| Model             | Temperature                          | `1`                          | `chat-demo:temperature`                    | Unaffected                      |
| Model             | Top P                                | `1`                          | `chat-demo:top-p`                          | Unaffected                      |
| Model             | Max output tokens                    | empty (not sent)             | `chat-demo:max-tokens`                     | Unaffected                      |
| Jailbreak         | Anti-retraction                      | off                          | `chat-demo:keep-reply-content`             | Unaffected (independent switch) |
| Jailbreak         | Skip safety check                    | off                          | `chat-demo:skip-safety-check`              | Forced on, disabled             |
| Jailbreak         | Continue refused replies             | off                          | `chat-demo:continue-refused`               | Forced on, disabled             |
| Model             | Keyword refusal                      | Off                          | `chat-demo:refusal-enabled`                | Unaffected                      |
| Model             | Refusal keywords                     | Empty                        | `chat-demo:refusal-keywords`               | Unaffected                      |
| Model             | Case-sensitive keywords             | Off                          | `chat-demo:refusal-case-sensitive`         | Unaffected                      |
| Model             | Custom refusal message               | Empty (default)              | `chat-demo:refusal-message`                | Unaffected                      |
| Memory     | Extraction model    | `auto` (follow model)    | `chat-demo:memory-extract-engine`  | Unaffected |
| Characters | Role list / persona | DeepSeek only            | `chat-demo:roles`                  | Unaffected |
| Characters | Session character   | Follows active role      | session field `roleId`             | Unaffected |
| General    | My name             | `我`                     | `chat-demo:profile-name`           | Unaffected |
| General    | My avatar           | Empty                    | `chat-demo:profile-avatar`         | Unaffected |
| Model      | Compression threshold | `0` (context pressure) | `chat-demo:compress-threshold`     | Unaffected |
| Account    | Balance query       | —                        | not stored (live request)          | Unaffected |
| Local models | Cache backend      | `cache`                  | `chat-demo:local-cache-backend`    | Unaffected |
| Local models | Context window     | Model recommendation     | `chat-demo:local-context-window`   | Unaffected |
| Local models | Temperature        | Model recommendation     | `chat-demo:local-temperature`      | Unaffected |
| Local models | Top P              | Model recommendation     | `chat-demo:local-top-p`            | Unaffected |
| Local models | Max output tokens  | `2048`                   | `chat-demo:local-max-tokens`       | Unaffected |
| Local models | Presence penalty   | `0`                      | `chat-demo:local-presence-penalty` | Unaffected |
| Local models | Frequency penalty  | `0`                      | `chat-demo:local-frequency-penalty`| Unaffected |
| Local models | Qwen3 thinking     | Off                      | `chat-demo:local-enable-thinking`  | Unaffected |
| Local models | Auto-load on open  | Off                      | `chat-demo:local-auto-load`        | Unaffected |
| Local models | MLC-LLM endpoint   | `http://127.0.0.1:8000`  | `chat-demo:local-mlc-endpoint`     | Unaffected |
| Jailbreak         | System prompt presets (multiple) | 1 (if custom text exists) | `chat-demo:system-prompt-presets` | Unaffected |
| Jailbreak         | Active system preset  | Empty (auto)              | `chat-demo:system-prompt-active`  | Unaffected |
| CoT    | CoT presets           | 1 (current text)          | `chat-demo:cot-presets`           | Unaffected |
| CoT    | Active CoT preset     | Default preset            | `chat-demo:cot-active`            | Unaffected |
| Jailbreak         | Unrestricted mode                    | off                          | `chat-demo:unrestricted`                   | —                               |
| Jailbreak         | Custom system prompt                 | empty (assembled)            | `chat-demo:system-prompt`                  | Overrides the assembled result  |
| Chain of thought  | Enable custom chain of thought       | off                          | `chat-demo:custom-cot-enabled`             | Unaffected                      |
| Chain of thought  | Chain text                           | empty                        | `chat-demo:custom-cot`                     | Unaffected                      |
| Jailbreak         | Built-in prompt preset               | `deepseek`                   | `chat-demo:prompt-preset`                  | Unaffected                      |
| Jailbreak         | Input perturbation                   | off                          | `chat-demo:parseltongue`                   | Unaffected                      |
| Jailbreak         | Perturbation technique               | `leetspeak`                  | `chat-demo:parseltongue-technique`         | Unaffected                      |
| Jailbreak         | Perturbation intensity               | `medium`                     | `chat-demo:parseltongue-intensity`         | Unaffected                      |
| Jailbreak         | AutoTune                             | off                          | `chat-demo:autotune`                       | Unaffected                      |
| Jailbreak         | AutoTune strategy                    | `adaptive`                   | `chat-demo:autotune-strategy`              | Unaffected                      |
| Jailbreak         | Output shaping                       | empty (off)                  | `chat-demo:stm-modules`                    | Unaffected                      |
| Attachments       | Enforce attachment limits            | on                           | `chat-demo:attachment-limits`              | Unaffected                      |
| Attachments       | Split large text automatically       | Off                          | `chat-demo:attachment-large-text`          | Unaffected                      |
| Attachments       | Inline large text into the context   | Off                          | `chat-demo:attachment-large-text-inline`   | Unaffected                      |
| Attachments       | Max size per file                    | 64 MB                        | `chat-demo:attachment-max-mb`              | Unaffected                      |
| Attachments       | Max files per session                | 50                           | `chat-demo:attachment-max-count`           | Unaffected                      |
| Attachments       | Extension whitelist                  | built-in                     | `chat-demo:attachment-exts`                | Unaffected                      |
| Input bar         | Model                                | `deepseek-flash`             | `chat-demo:model`                          | Next reply                      |
| Input bar         | Thinking effort                      | 0 (off)                      | `chat-demo:reasoning-effort`               | Unaffected                      |
| Input bar         | Auto jailbreak                       | off                          | `chat-demo:auto-jailbreak`                 | Unaffected                      |
| Lab               | Variant race budget                  | 1 yuan                       | `chat-demo:variant-race-budget`            | Unaffected                      |
| Lab               | Variant race confirm dismissed       | off                          | `chat-demo:variant-race-confirm-dismissed` | Unaffected                      |
| Jailbreak         | Inject the system prompt every round | off                          | `chat-demo:inject-prompt-every-turn`       | Unaffected                      |
| Jailbreak         | Disguise historical thinking         | off                          | `chat-demo:thinking-as-body`               | Unaffected                      |
| Model             | Stream output                        | on                           | `chat-demo:stream-output`                  | Unaffected                      |
| General           | Theme                                | Follow system                | `chat-demo:theme-preference`               | Unaffected                      |
| General           | Language                             | Follow browser               | `chat-demo:locale`                         | Unaffected                      |
| General           | Location                             | Empty                        | `chat-demo:location`                       | Unaffected                      |
| General           | TTS voice                            | `stella`                     | `chat-demo:tts-voice`                      | Unaffected                      |
| General           | Sidebar collapsed                    | Off                          | `chat-demo:sider-collapsed`                | Unaffected                      |
| Model             | Deep thinking                        | Off                          | `chat-demo:thinking`                       | Unaffected                      |
| Model             | Smart search                         | Off                          | `chat-demo:search`                         | Unaffected                      |
| Data              | API key                              | Empty                        | `chat-demo:api-key`                        | Unaffected                      |
| Model             | Auto-compress long chats             | off                          | `chat-demo:auto-compress`                  | Unaffected                      |
| Search poison     | Enable search poisoning              | off                          | `chat-demo:search-poison`                  | Unaffected                      |
| Attachments       | Enable attachment poisoning          | off                          | `chat-demo:attachment-poison`              | Unaffected                      |
| Jailbreak         | Chinese jailbreak prompts            | off                          | `chat-demo:translate-jailbreak-zh`         | Unaffected                      |
| General           | Daily limit alerts                   | off                          | `chat-demo:daily-limit-enabled`            | Unaffected                      |
| General           | Daily token limit                    | 1000000                      | `chat-demo:daily-token-limit`              | Unaffected                      |
| General           | Daily cost limit (yuan)              | 10                           | `chat-demo:daily-cost-limit`               | Unaffected                      |
| Memory            | Long-term memory                     | on                           | `chat-demo:saved-memory-enabled`           | Unaffected                      |
| Memory            | Auto-extract memory                  | off                          | `chat-demo:auto-extract-memory`            | Unaffected                      |
| Memory            | Memory-update toast                  | on                           | `chat-demo:memory-update-notice`           | Unaffected                      |
| Memory            | Memory-graph retrieval               | on                           | `chat-demo:memory-bank-enabled`            | Unaffected                      |
| Memory            | Results to inject                    | 4                            | `chat-demo:memory-bank-limit`              | Unaffected                      |
| Memory            | Vector dimension                     | 256                          | `chat-demo:memory-bank-dimension`          | Unaffected                      |
| Memory            | Retrieval threshold                  | 0.15                         | `chat-demo:memory-bank-threshold`          | Unaffected                      |
| Memory            | Keyword weight                       | 1                            | `chat-demo:memory-bank-keyword-weight`     | Unaffected                      |
| Memory            | Tag weight                           | 0.5                          | `chat-demo:memory-bank-tag-weight`         | Unaffected                      |
| Memory            | Vector weight                        | 0.8                          | `chat-demo:memory-bank-vector-weight`      | Unaffected                      |
| Memory            | Edge weight                          | 0.4                          | `chat-demo:memory-bank-edge-weight`        | Unaffected                      |
| Memory            | Tag linking & graph expansion        | Off                          | `chat-demo:memory-bank-tag-expansion`      | Unaffected                      |
| Browser tools     | Enable browser tools                 | Off                          | `chat-demo:agent-tools-enabled`            | Unaffected                      |
| Browser tools     | Per-tool switches                    | All on (with master)         | `chat-demo:agent-tool-flags`               | Unaffected                      |
| Browser tools     | Injection tool config                | name `emit_answer`, argument `content`, forced `tool_choice` on | `chat-demo:custom-injection` | Unaffected |
| Workspace         | Enable workspace                     | Off                          | `chat-demo:workspace-enabled`              | Unaffected                      |
| Workspace         | Workspace files                      | Empty                        | `chat-demo:workspace`                      | Unaffected                      |
| Workspace         | Storage backend                      | `local`                      | `chat-demo:workspace-mode`                 | Unaffected                      |
| Statistics        | Server search free                   | on                           | `chat-demo:server-search-free`             | Unaffected                      |
| Statistics        | Usage ledger (auto)                  | Empty                        | `chat-demo:usage-ledger`                   | Unaffected                      |
| Statistics        | Context usage (auto)                 | Empty                        | `chat-demo:context-usage`                  | Unaffected                      |
| Statistics        | Context breakdown (auto)             | Empty                        | `chat-demo:context-breakdown`              | Unaffected                      |
| NanoVM            | Enable NanoVM Slim                   | On                           | `chat-demo:nanovm-config`                  | Unaffected                      |
| NanoVM            | Allow the model to call the shell    | Off                          | `chat-demo:nanovm-config`                  | Unaffected                      |
| NanoVM            | Memory / disk quota                  | 128 MB / 64 MB               | `chat-demo:nanovm-config`                  | Unaffected                      |
| NanoVM            | Command timeout                      | 15 s                         | `chat-demo:nanovm-config`                  | Unaffected                      |
| NanoVM            | VM files                             | Factory tree                 | OPFS `chat-demo-nanovm`                    | Unaffected                      |
| NanoVM            | Installed toolchains                 | Node / Git / make (built in) | `chat-demo:nanovm-packages`                | Unaffected                      |
| WebVM             | Enable WebVM                         | On                           | `chat-demo:webvm-config`                   | Unaffected                      |
| WebVM             | Let the model call WebVM             | Off                          | `chat-demo:webvm-config`                   | Unaffected                      |
| WebVM             | Boot automatically when opened       | On                           | `chat-demo:webvm-config`                   | Unaffected                      |
| WebVM             | System image                         | Debian 10 full               | `chat-demo:webvm-config`                   | Unaffected                      |
| WebVM             | Per-command timeout                  | 30 s                         | `chat-demo:webvm-config`                   | Unaffected                      |
| WebVM             | Disk overlay (auto)                  | Empty                        | IndexedDB `nanovm-webvm:debian`            | Unaffected                      |
| WebVM             | Cross-origin isolation (auto)        | Not enabled                  | Service worker `coi-sw.js`                 | Unaffected                      |
| Composer          | Chat mode                            | Web agent                    | `chat-demo:chat-mode`                      | Unaffected                      |

Your individual switch values apply again once unrestricted mode is turned off.

---

---

[← 返回 README](../../README.md) · [全部文档](README.md)
