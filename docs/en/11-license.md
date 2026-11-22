## 11. License and credits

- Code based on [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo), under the [MIT](../../LICENSE) license. The build copies the license to `dist/LICENSE`; keep it when redistributing.
- `brand.png` and `brand_2.jpg` are artwork provided by the repository author and remain theirs; this project is not affiliated with DeepSeek.
- This is a personal fork, not an official DeepSeek project. Check the terms and costs of whichever API service you point it at.
- Thanks to the [Linux DO community](https://linux.do/) for discussion, feedback and testing support.
- Thanks to the [EasyJailbreak project](https://github.com/EasyJailbreak/EasyJailbreak) for the theoretical foundation.
- Thanks to [DeepSeek-Agent](https://github.com/Aoan2011/DeepSeek-Agent) for the reference implementation of the thinking slider, context ring and session statistics.
- Thanks to [dsh-unrestricted](https://github.com/yexi-by/dsh-unrestricted) for the reference jailbreak prompts and experiment settings.
- Thanks to [L1B3RT4S](https://github.com/elder-plinius/L1B3RT4S), the upstream source for GODMODE, the Hall of Fame combos and jailbreak prompts.
- Thanks to [Operit](https://github.com/AAswordman/Operit) for the memory graph, vector dimensions, retrieval weights and search-debug reference.
- Thanks to [DeepChat](https://github.com/YanJiuWeiYuanHui/DeepChat) for the long-term memory and daily token / cost alert reference.
- Thanks to [Remember](https://github.com/luomiluomi/Remember) for the character cards, My profile, compression threshold and account/usage reference, under the MIT license; this fork rewrites the interactions and does not copy its artwork or app icon.
- Thanks to [mlc-ai/web-llm-chat](https://github.com/mlc-ai/web-llm-chat) for the in-browser model catalog, WebLLM inference and MLC-LLM API client, Apache-2.0.
- Thanks to [huggingface/pybot](https://github.com/huggingface/pybot) for the PyBot rule-based chatbot source (Apache-2.0); `public/pybot.zip` is an offline snapshot of commit `24cbc04` with no source changes.
- The oversized-image resize logic is merged from upstream [deepseek-ai/chat-demo v0.1.3](https://github.com/deepseek-ai/chat-demo) (MIT).
- **WebVM / CheerpX**: the x86 virtualisation runtime and the default Debian image come from [Leaning Technologies](https://cheerpx.io). CheerpX is proprietary software, free for personal and open-source projects, and requires a commercial licence otherwise; this repository only calls the public runtime on their CDN and does not redistribute the engine files.
- **xterm.js**: the terminal component, MIT licensed, see [@xterm/xterm](https://github.com/xtermjs/xterm.js).
- **unkernel**: real Linux compiled to WebAssembly, by Pooya Parsa and contributors, MIT / GPL-2.0-only; the full upstream page, UP/SMP kernel and Alpine image are bundled under `public/unkernel/` (see `LICENSE-unkernel-*` there).
- The engines under `src/services/unrestricted/` (input perturbation, AutoTune, STM, race scoring, GODMODE prompt) are ported from [G0DM0D3](https://github.com/elder-plinius/G0DM0D3) and licensed [AGPL-3.0](../../src/services/unrestricted/COPYING-AGPL-3.0); that directory keeps its own license, separate from the MIT-licensed rest of the repo.

---

[← 返回 README](../../README.md) · [全部文档](README.md)
