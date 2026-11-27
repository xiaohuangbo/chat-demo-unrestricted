## 4. Behaviour matrix

| Scenario                    | Original                    | This fork, defaults (all switches off)                                                                                   | Unrestricted mode on                                      |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `system` field              | Official identity sentence  | Same                                                                                                                     | Persona + unrestricted rules block                        |
| `safety_check`              | Always `high`               | `high`                                                                                                                   | Not sent                                                  |
| Custom system prompt        | None                        | Empty = assembled; filled = sent verbatim                                                                                | Filled text wins; unrestricted no longer swaps the prompt |
| Streamed content on refusal | Discarded                   | Discarded (kept when anti-retraction is on)                                                                              | Same as default                                           |
| Refused turn in context     | No                          | No (yes when anti-retraction kept the body)                                                                              | Same as default                                           |
| Continue on refused reply   | Blocked                     | Blocked (switch can enable)                                                                                              | Allowed                                                   |
| Edit refused reply          | No editing at all           | Editable when content was kept                                                                                           | Same                                                      |
| Sampling parameters         | Not sent                    | Adjustable                                                                                                               | Adjustable                                                |
| Export of refused reply     | `CONTENT_FILTER` + template | Same (normal finish when content was kept)                                                                               | Same as default                                           |
| Other original features     | —                           | Search, attachments, branches, import/export, read-aloud, themes, i18n all preserved                                     | Same                                                      |
| Web search                  | Server-side                 | Kept by default; search poisoning can take over or rewrite the display                                                   | Same as default                                           |
| Custom chain of thought     | Not available               | Off by default; injected into system; the “Injected chain of thought” card shows above replies when deep thinking is off | Same as default                                           |
| Browser tools               | Not available               | Off by default; enabled tools are declared to the model and executed locally                                             | Same as default                                           |
| Virtual workspace           | Not available               | Off by default; the agent reads and writes localStorage virtual files, with confirmation for writes and deletes          | Same as default                                           |
| Chat mode                   | Not available               | Four entries in the composer (Chat only / Web agent / PTC / Creator) decide which client tools and round limit apply     | Same as default (independent of unrestricted mode)        |
| NanoVM Slim                 | Not available               | Enabled by default with model access off; terminal, on-demand toolchains, VM image import/export and quotas              | Same as default                                           |
| Context breakdown           | Not available               | Records the latest request's eight categories per session; display only                                                  | Same as default                                           |
| Prompt injection            | Not available               | Off by default; define the tool and argument, force `tool_choice` so the answer becomes the argument and is restored as text | Same as default                                           |
| Memory nodes                | Not available               | Settings → Memory filters by title / body / tags; every card edits title, body and tags in place                        | Same as default                                           |
| Unkernel page               | Not available               | Desktop + app launcher (80+ apps), terminals, Wayland windows, GL / Vulkan; Alpine by default                           | Same as default                                           |
| Session pinning             | Not available               | Pin / unpin one chat from its “…” menu; multi-select pins or deletes several at once; pins only affect the session list | Same as default              |

---

---

[← 返回 README](../../README.md) · [全部文档](README.md)
