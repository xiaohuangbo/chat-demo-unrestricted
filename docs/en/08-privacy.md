## 8. Data, privacy, and network

- API key and settings: browser localStorage (keys listed in section 5).
- Search-poison settings (time, replacement / filter rules, custom results) live only in localStorage; when enabled they are sent as system context to the API origin you configured.
- Attachment-poison settings live only in localStorage; original attachments stay on this device, the processed copies are uploaded, and companion text attachments are sent as ordinary files.
- Conversations and original attachments: IndexedDB, isolated per browser profile and site origin.
- The only outbound traffic goes to the API origin you configured (default `https://api.deepseek.com`): `/models` for key validation, `/anthropic/v1/messages` for chat, `/anthropic/v1/files` for attachments, and the ASR / TTS endpoints for speech.
- Browser tools / workspace: switches live in localStorage; workspace files default to `chat-demo:workspace` (binary stored as base64, roughly a third larger), and in OPFS mode live as raw bytes under the origin-private `chat-demo-workspace/` directory (inaccessible to other sites); tool results / artifacts go into IndexedDB with the reply.
- Statistics: `chat-demo:usage-ledger`, `chat-demo:context-usage` and `chat-demo:context-breakdown` store aggregate numbers only, never message text.
- Tools reach third parties only where the capability requires it: Open-Meteo (weather), BigDataCloud (reverse geocoding), and whatever page the agent is told to fetch; everything else runs locally.
- The Unkernel page runs in an iframe and ships with the app; guest networking goes through Wisp proxies (anura.pro / mercurywork.shop by default), whose operators see the host names, ports and plain-HTTP content the guest connects to, while TLS stays end to end; because the page always passes `routes=0`, Debian’s apt indexes and `.deb` files take that proxy too instead of the upstream CORS mirror (`mirror.unkernel.dev` only accepts allowlisted page origins and answers this app with 403), so those requests never reach that mirror. App first-run downloads (Steam, browsers, distro packages, and so on) are made by the page too: same-origin files with `fetch()`, external ones over Wisp or a mirror;
- Guest GL / Vulkan / VA-API render locally (WebGL2 / WebGPU / WebCodecs) and no frames are uploaded; the 24 MiB DSH go binary ships with this repository and is not downloaded;
- “Sign in with DeepSeek account” sends one API-key request to `https://api.deepseek.com/user/balance` to confirm account availability and balance; the sign-in state (key tail, balance snapshot, sign-in time) stays on this device, no copy of the key is stored, and nothing goes to a third party; the platform’s OAuth flow needs a host to receive its callback, so a static site does not implement it.
- The prompt-injection tool only changes the request shape (`tools` / `tool_choice`) and adds no new outbound target; memory node filtering runs on the local list only and does not affect retrieval or injection;
- No analytics, no telemetry, no third-party scripts, no relay server.
- History import/export uses ZIP archives; exports contain conversations and locally available image originals, but no API keys or settings. See the [history archive documentation](../../src/services/chat/history/README.md) for the format and retention rules.

---

---

[← 返回 README](../../README.md) · [全部文档](README.md)
