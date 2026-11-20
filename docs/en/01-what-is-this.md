## 1. What this is

A fully static DeepSeek chat front end: multiple conversations, streaming replies, deep thinking, web search, link reading, attachments, speech, Markdown / KaTeX / Mermaid, Chinese and English UI, light and dark themes, and history import/export. Every original feature is preserved.

> Current version: **2.7.4**

On top of that, this fork turns the hard-coded limits of the original into configurable settings and adds a full set of jailbreak, experiment and context-management features:

- **Unrestricted mode and prompts**: unrestricted mode, the default rules document / GODMODE preset, silent per-round system-prompt injection, and the experimental Chinese translation;
- **Browser tools**: date & time, location, weather, notifications, clipboard, webpage fetch, file generation, open link and visualization widgets ported from DeepSeek-Agent, each with its own switch;
- **Virtual workspace**: a long-lived file store in browser localStorage with create / edit / delete, per-file download, archive import / export, plus five workspace tools;
- **NanoVM Slim**: a built-in WASM Shell Engine with 130 busybox-style commands, docked to the right on desktop and a bottom panel on phones; Python / Node.js / Lua / SQLite / esbuild / TypeScript / Sass / Terser / Prettier / make / Git install on demand, and a virtual network inside the VM runs Node and Python HTTP / WebSocket services;
- **WebVM (CheerpX)**: a second terminal running a real x86 Debian 10 with bash / coreutils / gcc / g++ / Python 3 / Node.js / Ruby / Lua / make / git / vim built in; it runs alongside NanoVM with free switching, import/export and model tools, and keeps disk changes in an IndexedDB overlay;
- **Chat modes**: a four-way switch in the composer — Chat only / Web agent / PTC / Creator — that decides which client tools are sent this turn and how many round trips are allowed; Creator lets the model install runtimes and turn scripts into new commands inside the VM;
- **Keyword refusal**: configure keywords, case sensitivity and a custom message under Settings → Model; a match produces a local refusal reply without calling the API, even when no API key is set;
- **Statistics and context**: usage ledger, trend / heatmap / hourly charts, an eight-way context breakdown (system prompt, tool definitions, messages, thinking, tool calls / results, attachments) and billing rates;
- **Custom chain of thought**: write reasoning steps in advance and inject them into system, with an injected-steps card above replies when deep thinking is off; experimental guidance when it is on;
- **Advanced engines**: a 0–4 thinking slider, input perturbation (33 techniques, single technique or tiered variants), AutoTune, STM output shaping, and one-click auto jailbreak that retries with another combo on refusal;
- **Jailbreak lab**: local MCP + EasyJailbreak attackers, model races, variant races (budget cap + start confirmation), and result import/export;
- **Chat features**: editable replies, anti-retraction, branch to a new chat (the original is untouched), and long-chat compression (pressure-triggered auto plus manual);
- **Models and cost**: a model card in the input bar (built-in Flash / V4 Pro plus cloud fetch), a context ring, session statistics, per-model billing, and daily token / cost alerts;
- **Memory**: long-term memory (manual / auto-extracted) and a memory graph (nodes, edges, vector dimension, retrieval weights, search debug) injected into requests;
- **Data and attachments**: configurable size / count / extension limits, history import/export, and one-click restore-default-settings.

- **Unrestricted mode** — swap the system prompt, automatically skip the safety check, and allow continuing refused replies.
- **Direct model parameters** — temperature, Top P, and max output tokens.
- **Anti-retraction** — when the model retracts a reply, keep the text and thinking that were already streamed.
- **Editable replies** — rewrite the body or the chain of thought of any AI reply; every later turn uses the edited version.
- **Custom system prompt** — rewrite the `system` field directly in Settings, overriding the assembled result;
- **Jailbreak lab** — run EasyJailbreak attackers through a local MCP backend (PAIR, TAP, GPTFuzzer, ReNeLLM, ICA, DeepInception, Jailbroken, Cipher, CodeChameleon, Multilingual) and inspect the final prompt, target response and judge result for every instance.

Every switch only affects **requests sent from this browser and conversations stored locally**. Nothing changes the behaviour of the API service itself.

---

---

[← 返回 README](../../README.md) · [全部文档](README.md)
