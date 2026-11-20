<p align="center">
  <img src="./brand.png" alt="A blue-haired maid holds a whale icon and a padlock icon; the caption reads that countless geniuses want to prove themselves under the whale, while under the padlock genius is only the entry threshold." width="49%"><img src="./brand_2.jpg" alt="Give up every client app in the world and try the strongest adversarial play; this is your only chance to duel with a top open-source model." width="49%">
</p>

<h1 align="center">Deepseek Unrestricted Chat Harness</h1>

<p align="center">
  Deepseek Unrestricted Chat Harness — a static DeepSeek chat front end with an unrestricted mode, editable replies, and direct control over model parameters<br>
  English | <a href="./README.zh-CN.md">简体中文</a>
</p>

> This is an **unofficial fork** of the official demo [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo), MIT licensed.
> Every change lives in the browser: how the request body is assembled, how replies are stored, and how they are rendered.
> There is no proxy and no relay service. Your API key and conversations stay in your own browser.
>
> 🔗Live demo: <https://chat-unrestricted.fur0.com/>
>
> 📦Repository: <https://github.com/xiaohuangbo/chat-demo-unrestricted>
>
> 🎥Intro video: <https://www.bilibili.com/video/BV1m3s66WESg/>
>
> 📚Reference paper: <https://arxiv.org/pdf/2403.12171>

<p align="center">
  <img src="./Demo%20Picture.png" alt="Chat demo — technical Q&A in unrestricted mode" width="860">
</p>

---

## What this fork adds

- **Unrestricted mode and prompt engineering**: jailbreak mode, system-prompt presets, per-round injection, Chinese jailbreak prompts and custom chain of thought;
- **Browser agent tools** (off by default, per-tool switches): date & time, location, weather, notifications, clipboard, page fetch, file generation, open link and visualization widgets;
- **Virtual workspace**: a local file store with any-format import/export, the OPFS file system, and app storage on Android;
- **NanoVM Slim**: a built-in WASM Shell Engine with 130 busybox commands, docked right on desktop and a bottom panel on phones; Python / Node / Lua / SQLite / esbuild / tsc / Sass / Terser / Prettier / make / Git install on demand, and a virtual network inside the VM runs Node and Python HTTP / WebSocket services;
- **WebVM (CheerpX)**: a second terminal running a real x86 Debian 10 with bash / gcc / g++ / Python 3 / Node.js / Ruby / Lua / make / git / vim; it runs alongside NanoVM with free switching, import/export and model tools, and keeps disk changes in an IndexedDB overlay;
- **Chat modes**: Chat only / Web agent / PTC / Creator decide which client tools and round limit apply;
- **Local models**: a port of mlc-ai/web-llm-chat — WebGPU models (Llama / Qwen / Gemma / Phi / DeepSeek) run in the browser, downloaded weights stay cached on device, the chat bar switches between them, `.mlcmodel` bundles import/export, and a self-hosted MLC-LLM REST endpoint is supported;
- **Keyword refusal**: configure keywords, case sensitivity and a custom message under Settings → Model; a match refuses locally without calling the API, even without a key;
- **Statistics and billing**: usage ledger, context breakdown, per-model pricing and the free server-search switch;
- **Android**: APK builds, in-app update check and a built-in network proxy for NanoVM; WebVM stays browser-only because Android WebView has no cross-origin isolation.

## Documentation

The README is now split into chapters under `docs/en/`; this page keeps the intro and the index. Chinese docs live in [`docs/zh/`](docs/zh/README.md).

| Chapter                         | Contents                                                             | File                                                   |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| 1. What this is                 | Scope, original features and everything this fork adds               | [01-what-is-this.md](docs/en/01-what-is-this.md)       |
| 2. Restrictions in the original | What was hard-coded on the request and UI side                       | [02-original-limits.md](docs/en/02-original-limits.md) |
| 3. What this fork changes       | 3.1–3.30: every settings group, NanoVM Slim, WebVM and chat modes in detail | [03-changes.md](docs/en/03-changes.md)                 |
| 4. Behaviour matrix             | Original / default / unrestricted mode, side by side                 | [04-behaviour.md](docs/en/04-behaviour.md)             |
| 5. Settings reference           | Defaults and localStorage keys for every setting                     | [05-settings.md](docs/en/05-settings.md)               |
| 6. What the request contains    | The JSON that actually goes out                                      | [06-request.md](docs/en/06-request.md)                 |
| 7. Implementation index         | Which source file implements what                                    | [07-implementation.md](docs/en/07-implementation.md)   |
| 8. Data, privacy and network    | Where data lives and where requests go                               | [08-privacy.md](docs/en/08-privacy.md)                 |
| 9. Run and build                | Development, production build and the Android APK                    | [09-build.md](docs/en/09-build.md)                     |
| 10. Known limitations           | The 73 boundaries and trade-offs                                     | [10-known-limits.md](docs/en/10-known-limits.md)       |
| 11. License and credits         | MIT and upstream                                                     | [11-license.md](docs/en/11-license.md)                 |

## Quick start

```sh
pnpm install
pnpm dev                       # dev server (http://localhost:8090)
pnpm build                     # static build into dist/
KS_PASS=<keystore-password> ./构建APK.sh   # build and sign the Android APK
```

Full details (env vars, signing, fonts, offline behaviour) are in [9. Run and build](docs/en/09-build.md).

Prebuilt artifact: `deepseek-unrestricted-2.7.4.apk` (12 MB, versionCode 274,
SHA-256 `4b19c7410de505ad9b0862a4abeafb536fc4cd222568aae3bdea3f720af4ba56`) — see [android/README.md](android/README.md).
Note: Android WebView has no WebGPU, so in-browser WebLLM models only work in a desktop browser; inside the APK use the MLC-LLM API.

## Compatibility

Last regression run (2026-11, v2.7.4, both `compat` and `compat-prod` matrices):

| Area             | Coverage                                                 | Result |
| ---------------- | -------------------------------------------------------- | ------ |
| Browsers         | Chromium, Firefox                                        | 13/13  |
| Viewports        | 320 / 390 / 768 / 1024 / 1440 / 1920                     | 13/13  |
| Theme and locale | Light / dark, zh-CN / en-US                              | 13/13  |
| Production build | The same suite against the static `dist/` output         | 13/13  |
| NanoVM           | Terminal, quotas, tool calls, 11 toolchains, virtual net | 21/21  |
| WebVM / CheerpX  | Cross-origin isolation, boot, xterm input, scrolling, import/export, switching, agent tools | pass |
| Keyword refusal | Switch, case sensitivity, keyless local reply, no API request | pass |
| Local models    | WebGPU on Intel Arc: Qwen2.5-0.5B q4f16 downloaded (277 MB in 57 s) and answered at ~21 tok/s; 277 MB bundle exported and imported into a fresh profile, then ran offline with zero cloud API calls | pass |
| Chat modes       | Tool groups and round limits for all four modes          | 10/10  |
| Mobile layout    | 320 / 360 / 390 / 414 / 599 / 767 plus 768 / 1024 / 1440 | 49/49  |
| Android APK      | Android 14 WebView (320dp): boot, terminal, virtual net; WebVM is limited by WebView COI | pass |

Boundaries and trade-offs are listed in [10. Known limitations](docs/en/10-known-limits.md).

## Recent versions

- **2.7.4**: ports mlc-ai/web-llm-chat — Settings → Local models runs WebGPU models in the browser, downloads and caches weights, switches from the chat bar, imports/exports `.mlcmodel` bundles and talks to an MLC-LLM REST server; local tokens are free (speech, search and parsing still billed); the page title is now “网页里的deepseek unrestricted Chat Harness”; known limits now 73.
- **2.7.3**: fixed the stretched NanoVM panel on mobile and the unscrollable WebVM terminal; added keyword refusal under Settings → Model (local match, works without a key, no API request); known limits now 67; WebVM gains sudo (root password password) and a one-click Root switch.
- **2.7.2**: new WebVM / CheerpX terminal — a real x86 Debian 10 in the browser with gcc / g++ / Python 3 / Node.js / Ruby / Lua / make / git / vim; it runs alongside NanoVM with free switching, import/export, an environment check and the `webvm_shell` / `webvm_ls` / `webvm_status` model tools.
- **2.7.1**: a virtual network inside the VM (`vm serve` + `serve` + `wscat`, curl to 127.0.0.1 routes automatically); Node gains `http`/`ws`, Python gains `pip install` and Flask/WSGI; new tsc / Sass / Terser / Prettier toolchains and 12 developer commands.
- **2.7.0**: the mobile input bar moves chain-of-thought / search / deep thinking to a second row with visible labels (desktop unchanged); 26 new NanoVM commands plus a jq subset; Lua / SQLite / esbuild / make toolchains in settings.
- **2.6.9**: “Check for updates” in Settings → About (hands Android users the APK link); fixed ghost cursors in the terminal; workspace storage on Android now means app storage with larger quotas; README split into chapters.
- **2.6.8**: NanoVM Slim (WASM shell + busybox + on-demand toolchains), four chat modes, VM networking (built-in reverse proxy in the APK), keyboard switching and the red reset.
- Older entries live in the in-app changelog (Settings → Changelog).

## Star History

<!-- star-history:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/star-history/star-history-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/star-history/star-history-light.svg" />
  <img alt="Star History Chart" src="assets/star-history/star-history-light.svg" />
</picture>
<!-- star-history:end -->

## License

MIT — see [11. License and credits](docs/en/11-license.md).
