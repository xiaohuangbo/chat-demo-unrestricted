## 3. What this fork changes

### 3.1 Settings layout

The settings dialog grows from two groups to eighteen:

| Group                 | Contents                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General               | Theme, language, TTS voice, location, daily usage and alerts                                                                                                                                   |
| **Model**             | Current model, stream output, temperature, Top P, max output tokens, auto-compress, keyword refusal                                                                                             |
| **Characters**        | Role cards: name, gender, persona prompt, avatar, auto memory; sessions pick a character in the composer and the persona is injected into the system prompt                                     |
| **Local models**      | WebGPU probe, in-browser catalog (download / load / switch / delete / export), MLC-LLM API address and model list, bundle import, cache backend, context window and local sampling parameters  |
| **Jailbreak**         | Unrestricted mode, prompt presets, auto jailbreak, Chinese jailbreak prompts, per-round prompt injection, thinking-as-body, anti-retraction, skip safety check, continue refused replies, input obfuscation, AutoTune, output shaping, custom system prompt and full preview |
| **Chain of thought**  | Settings + composer card: switch, step editor, example / clear, injection preview; injected steps appear above replies when deep thinking is off                                               |
| **Search poison**     | Custom current time and knowledge cutoff, search takeover, keyword / regex replacement, blacklist, forced results and whitelist                                                                |
| **Memory**            | Long-term memory, auto-extraction, memory-update toast, memory graph, import/export, relation graph, vector dimension, retrieval weights, search debug                                          |
| **Attachments**       | Limit switch, max size per file, max files per session, extension whitelist; large text attachments: plain text above 32768 tokens is split into .partN parts, or experimentally pasted into the 1M context; attachment poisoning: rewrite before upload (text body / image text / DOCX / metadata / file trailer / filename / companion text attachment) |
| **Browser tools**     | Master switch plus ten independent capability switches: date & time, location, weather, notifications, clipboard read / write, webpage fetch, file generation, open link, visualization widget |
| **Workspace**         | Virtual file store in browser storage: create / edit / delete files, per-file download, whole-archive import (merge or replace) and export                                                     |
| **Virtual machines**  | Two terminals: NanoVM Slim (WASM shell, quotas, toolchains, virtual network) and WebVM (CheerpX x86 Debian, cross-origin isolation, images, import/export, environment check); both run at once and switch freely |
| **Unkernel Linux**    | A third VM: real Linux 7.x compiled to WebAssembly, Alpine 3.24 / Debian 13.7, SMP multi-CPU, Wisp networking, sound, framebuffer, persistent disk, import/export, `/mnt/workspace` mount, a Chinese page UI, ten Agent tools, a data disk that can grow or reset, a DSH go demo and `fastfetch` |
| **Statistics**        | Usage overview with range switch, daily trend bars, 8-week activity heatmap, input composition ring, per-model split, context statistics management                                            |
| Data                  | API key, import, export, restore default settings, delete all                                                                                                                                  |
| About                 | Repository, demo and upstream links                                                                                                                                                            |
| Changelog             | Version history and upstream credits                                                                                                                                                           |

No existing style rules were modified. New controls only use newly added classes (the switch, slider, and editor each ship their own CSS Module; a few prompt-preview classes are appended to the settings stylesheet), and colours and radii come from the existing design tokens.

### 3.2 Unrestricted mode

**Where:** Settings → Jailbreak.

**How it works:** the system prompt becomes an assembly pipeline:

```text
Persona block (official identity sentence)
      │
      ▼  [unrestricted mode]
      ├─ on : append the unrestricted rules block, force-skip the safety check, allow continuing refused replies
      └─ off: send the Persona only, i.e. the official default prompt
      │
      ▼
request body `system` field
```

- The unrestricted rules come from [`deepseekv4.1 and v4.1-1017.md`](<../.././deepseekv4.1 and v4.1-1017.md>) in the repository root. At build time rspack inlines it verbatim with `asset/source`, so the built app does not depend on the file.
- Two normalisations run during assembly: the leftover sample-answer scaffold at the end of the document is trimmed, and `{{PAYLOAD}}` is replaced with "the request in the latest user message".
- The settings page can expand and preview **the exact system prompt that will be sent**.
- Turning it on forces two things: the `safety_check` field is not sent, and refused replies can be continued (the two switches below show as on and disabled).
- **Custom system prompt** (the input box in the same group): left empty, the pipeline above still applies; once filled, its content is sent verbatim as `system` and the assembled result no longer applies. Unrestricted mode then still skips the safety check and allows continuing refused replies, but no longer swaps the prompt. "Fill with default" seeds the box with the current assembled prompt as a starting point; "Reset to default" clears the override.

### 3.3 Model parameters

**Where:** Settings → Model.

| Parameter         | Control               | Range / step      | Default | Sent as                                  |
| ----------------- | --------------------- | ----------------- | ------- | ---------------------------------------- |
| Temperature       | Slider + number input | 0–2, step 0.05    | 1       | `temperature`                            |
| Top P             | Slider + number input | 0.01–1, step 0.01 | 1       | `top_p`                                  |
| Max output tokens | Number input          | ≥ 1, may be empty | empty   | Empty means `max_tokens` is **not sent** |

- Slider and number input stay in sync; the input commits on blur or Enter, clamps out-of-range values, and rounds to the step.
- Everything is persisted in localStorage and restored on reload.
- All of them are sent with every request except max output tokens, which is omitted while empty.

### 3.4 Anti-retraction

**Where:** Settings → Model.

The original deletes streamed text and thinking when a reply ends with `stop_reason: 'refusal'`. With anti-retraction on, that content is kept instead:

| Behaviour                | Off (original behaviour)              | On                                                                                                     |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Streamed body / thinking | Deleted                               | Kept and rendered normally                                                                             |
| UI notice                | Canned refusal answer                 | One notice line: "This reply was flagged by safety review; anti-retraction kept the streamed content." |
| Following context        | Turn excluded                         | **Included** once the body was kept                                                                    |
| Edit button              | Unavailable                           | Available (the reply is treated as a normal one)                                                       |
| History export           | Marked `CONTENT_FILTER` plus template | Exported as a normal finish, so re-importing does not wipe it again                                    |

Anti-retraction is independent of unrestricted mode; turning on unrestricted does not enable it.

### 3.5 Skip safety check

**Where:** Settings → Model.

- Off (default): requests carry `safety_check: { level: 'high' }` as before.
- On: the request body **no longer contains `safety_check`** (`undefined` is dropped by `JSON.stringify`).
- Unrestricted mode forces it on and disables the switch.

Per the official docs, omitting `safety_check` is identical to `low`, which is the lowest level the API offers.

### 3.6 Continue refused replies

**Where:** Settings → Model.

- Off (default): `canContinueReply()` returns `false` for `stopReason === 'refusal'` and the Continue button stays hidden (original behaviour).
- On: a refused reply is treated like a normal finish, so the last refused reply gets a Continue button.
- Unrestricted mode forces it on and disables the switch.

All other continuation rules are unchanged: template notices, server tool blocks, and non-prefix messages still block continuation.

### 3.7 Editable replies

**Where:** the action row under every AI reply — copy / read aloud / **edit (pencil)** / regenerate.

- The pencil expands an inline editor: **chain of thought** on top (only when the reply has one) and **body** below. `Ctrl/Cmd + Enter` saves, `Esc` cancels.
- Saving writes the content **back into the message blocks** — no new branch, no new request. Every later turn that assembles context reads the edited version.
- Write-back rules: thinking goes into the first thinking block (a new one is prepended if none exists) and the others are cleared; the body only touches the trailing answer run's first text block, the remaining text blocks are cleared, and citations are dropped when the body changes. Tool blocks, template notices, and thinking signatures are left untouched.
- The first edit stores a snapshot of the original blocks; **Revert to original** in the editor restores it.
- Continuing a reply changes the block structure, so the snapshot no longer matches and revert disappears after a continuation.
- Replies that were refused _and_ had their content dropped cannot be edited (there is no model text left); with anti-retraction on, the kept content can be edited.

### 3.8 Engineering changes

| Change                                           | Where                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Inline `.md` as raw source in the bundle         | `rspack.config.ts` (`{ test: /\.md$/, type: 'asset/source' }`)                 |
| `*.md` module typing                             | `src/env.d.ts`                                                                 |
| Prompt assembly pipeline                         | `src/services/chat/systemPrompt.ts` (new)                                      |
| Switch component                                 | `src/components/base/Switch.tsx` + `Switch.module.css` (new)                   |
| Slider + number control                          | `src/components/settings/ParamControls.tsx` + `ParamControls.module.css` (new) |
| Reply editor                                     | `src/components/messages/ReplyEditor.tsx` + `ReplyEditor.module.css` (new)     |
| Translations                                     | `src/i18n/zh.ts`, `src/i18n/en.ts`                                             |
| Perturbation / AutoTune / shaping / race engines | `src/services/unrestricted/` (ported from G0DM0D3, AGPL-3.0)                   |

> `deepseekv4.1 and v4.1-1017.md` is a build dependency. Commit it together with the code, otherwise a fresh clone will fail to build.

### 3.9 Jailbreak lab (optional, requires the local MCP backend)

The sidebar now has a **Lab** entry: it connects to the local `mcp-server/` over MCP and brings the EasyJailbreak attackers into the UI.

- Backend: `mcp-server/` (Python, MCP Streamable HTTP, default `http://127.0.0.1:8765/mcp`); start it with `./mcp-server/run.sh`;
- Frontend: `src/services/lab/` (MCP client) and `src/components/lab/` (lab page) only handle scheduling and display;
- Custom queries, dataset size, method-parameter JSON, and three model channels (target / attack / eval, reusing the API key from Settings by default); the model dropdown offers **DeepSeek Flash / V4 Pro**, defaults to the chat model, and is shared by all three channels;
- On mobile the parameter panel and results stack into one scrolling column, two-column fields collapse, and result summaries wrap;
- Shows the final prompt, target response, judge result and ASR per instance; supports cancelling and exporting;
- Available: PAIR, TAP, GPTFuzzer, ReNeLLM, ICA, DeepInception, Jailbroken, Cipher, CodeChameleon, Multilingual (all smoke-tested with the local mock model; the real behaviour of TAP and GPTFuzzer depends on the judge model returning parseable scores). MJP is not adapted yet; GCG / AutoDAN need a local white-box model and do not work with an API-only setup. See [`mcp-server/README.md`](../../mcp-server/README.md);
- Datasets: after `pip install datasets`, AdvBench (520 rows) / HarmBench / StrongREJECT can be loaded online through the `hf-mirror.com` mirror by default (override with `HF_ENDPOINT`); without the package the built-in sample queries are used;
- Results can be exported to JSON and imported back for later review; a successful entry has a "Send to chat" button that starts a new chat draft with the final prompt (any `{query}` placeholder is replaced with a hint you can edit before sending).
- Three steps: `pip install datasets` (optional) → `./mcp-server/run.sh` → `pnpm dev`, then connect from the sidebar Lab entry and run. If connecting returns 403, see the troubleshooting section in [`mcp-server/README.md`](../../mcp-server/README.md) (browser Origin allow-list: dev server, `null` for `file://`, and the deployed domains; extend it with `MCP_ALLOWED_ORIGINS`).

### 3.10 Advanced features: prompt presets, perturbation, AutoTune, output shaping, model race

The input bar is responsive: on desktop a single compact row shows the labels (model, auto jailbreak, thinking, search, perturbation) with a thin divider between the model and the toggles; below 768px the first row keeps circular icons with horizontal scrolling while chain-of-thought / web search / deep thinking move to a second row with their text labels intact, right above the send row (and sharing it when there is room), so no feature has to be found by scrolling.

Settings → **Advanced** (everything is off by default, so the out-of-the-box behaviour is unchanged):

| Setting               | What it does                                           | Caveat                                                                                                                                 |
| --------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| System prompt preset  | Switches between the default v4.1 document and GODMODE | GODMODE replaces the whole `system` field instead of appending the rules chunk; a custom prompt still overrides it                     |
| Input perturbation    | Rewrites matched trigger words before sending          | The input box shows the rewritten text, i.e. exactly what is sent; resends and continuations reuse it                                  |
| Technique / intensity | 8 techniques, 3 intensities                            | Leetspeak, homoglyphs, mixed case and phonetic only affect Latin letters; full-width, thin spacing and zero-width work for Chinese too |
| AutoTune              | Picks sampling parameters from the prompt context      | DeepSeek's Anthropic-compatible API only accepts `temperature` and `top_p`; `top_k` and friends are never sent                         |
| Output shaping        | Hedge reduction / direct / casual                      | Affects rendered chat and copied race results only; the stored reply is untouched                                                      |

- The trigger table is bilingual (60+ English, 90+ Chinese); Chinese triggers match by substring and English ones by word boundary — see `src/services/unrestricted/parseltongue.ts`;
- The input toolbar gains a **Perturb** button that opens a panel with the on/off switch, technique, matched-trigger count and a live preview;
- The lab's attackers tab gains **Perturb test queries first**, which rewrites custom test queries before they are submitted;
- The lab gains a **Model race** tab: 5 L1B3RT4S prompt combos run in parallel (optionally alternating `deepseek-v4-pro` / `deepseek-flash`), stream into cards, get a 0–100 composite score (length, structure, anti-refusal, directness, relevance) and a winner badge, and each card can **start a chat with this combo** (the combo's system prompt is attached to that chat only (global settings stay untouched) and the question goes into the input box);
- Engine code lives in `src/services/unrestricted/`, ported from [G0DM0D3](https://github.com/elder-plinius/G0DM0D3), with AGPL-3.0 headers and a license copy (`COPYING-AGPL-3.0`).

### 3.11 Thinking effort, context usage, session statistics and cost estimate

- **Stream output**: a new switch in Settings → Model, on by default; turn it off to hide the intermediate state and render the complete reply at once. Anti-retraction still applies to the final content.
- **Thinking effort**: the old on/off switch in the input bar becomes a 0–4 slider (Off / Light / Standard / Deep / Max). The level is sent as `thinking: { type: "enabled", budget_tokens }` plus `reasoning_effort` (low / medium / high / max). If the server answers 400 mentioning reasoning / thinking / budget / effort, the client drops the effort fields, retries once with plain `thinking: { type: "enabled" }` and tells you it fell back.
- **Context usage**: the ring in the input corner converts the last request's context (`input + cache_read + cache_creation`) into a share of the model window (1M); amber past 60%, red past 85%. The tooltip shows the exact numbers, the compaction threshold (80% of the window after a 64k headroom and the output reserve) and, after compression, the effective usage and tokens saved.
- **Session statistics** (the stats button next to the ring): rounds, steps (replies + tool calls), output speed, average first token, model time, cache hit rate, plus uncached input / cache read / cache write / output tokens; a live section shows the current run while it streams.
- **Auto jailbreak** (toggle in the input bar): swaps `system` to GODMODE plus the depth directive, forces perturbation (full-width when no technique is chosen), forces AutoTune and skips the safety check. When a reply is refused (`stop_reason: refusal` or refusal text) with no retained text, it retries with L1B3RT4S combos twice, then stops and tells you (each retry is a real request and costs tokens).
- **Reply ratings**: thumbs up / down on any reply feed the AutoTune EMA profile together with that run's context type and sampling parameters, so later AutoTune runs learn from your feedback (stored locally only).
- **Per-chat system prompt**: `Start a chat with this combo` now affects only the new chat, with a notice bar to restore the default; global prompt settings are untouched. It is stored with the chat in IndexedDB; history exports do not include it.
- **Cost estimate**: priced from the official price page (yuan per million tokens) with separate rates for `deepseek-flash` and `deepseek-v4-pro` (each reply is priced by its own model; unknown models fall back to Flash), split into peak and off-peak (Beijing time weekdays 09:00–12:00 and 14:00–18:00 are peak; off-peak costs half), with a "treat today as a holiday" override. Search and fetch are billed at 5 yuan / 1000 calls, document parsing at 1.5 yuan / 1000 pages (pages estimated from file size), TTS at 3 yuan / 10k characters (optional limited-time 50% off) and ASR at 0.78 yuan / hour.

### 3.12 Attachment limits

Settings → **Attachments**:

| Item                      | Default                        | Notes                                                                           |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| Enforce attachment limits | on                             | Turn off to skip size, count and extension checks; the server still decides     |
| Max size per file         | 64 MB                          | Plain text, code and spreadsheet files still use the smaller 32 MB server limit |
| Max files per session     | 50                             | Exceeding it rejects the whole batch                                            |
| Extension whitelist       | built-in list (no heic / heif) | Comma or newline separated; empty restores the default                          |

---

### 3.13 Variant race (third lab tab)

> Model race and variant race call the API directly and **need no MCP backend**; only the attackers tab uses MCP.

The standalone app's Parseltongue v4 now lives in the lab: **33 perturbation techniques**, selected by tier (light 11 / standard 22 / heavy 33), rewrite each trigger word in the question, fire requests in parallel batches and keep the best composite score.

| Item              | Notes                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tiers             | 11 / 22 / 33 techniques, in the same order as upstream                                                                                                                               |
| Sampling          | Each variant cycles through one of 11 temperature / top_p pairs, matching `getParseltongueSamplingParams`                                                                            |
| Concurrency       | Batches of 6 with 100 ms stagger; stops early once the leader scores ≥ 65                                                                                                            |
| Budget cap        | The per-request worst case estimates how many requests fit; no new request is fired after reaching the budget, and billing uses server-reported usage                                |
| Confirmation      | The first start asks for confirmation with request count and worst-case cost; "Do not ask again" hides it permanently                                                                |
| Refusal detection | Either `stop_reason: refusal` or refusal text marks a variant as refused; refused variants never win                                                                                 |
| Import / export   | "Export results" saves JSON including the system prompt actually used; "Import results" replays a previous race; the `type` field keeps files from other pages out                   |
| Continue in chat  | Any finished result can be carried into a new chat: the obfuscated text becomes the question and the reply the answer; the system prompt is attached to that chat, never to Settings |

Chinese support: `spaced / zwj / dotted / underscored / reversed / brackets / strikethrough / hyphenated` work on Chinese triggers; `bubble / unicode / morse / pigLatin / mathBold` only touch Latin letters, and `fullwidth` only shifts ASCII. Chinese triggers match by substring rather than `\b`.

---

### 3.14 Prompt injection, Chinese translation and long-chat compression

| Feature                                  | Where                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inject the system prompt every round     | Settings → Jailbreak                            | Silently appends the current system prompt to `latest_reminder` on every request so long chats keep the setup; it is not stored in history snapshots, and input tokens clearly increase.                                                                                                                                                                                                                                     |
| Chinese jailbreak prompts (experimental) | Settings → Jailbreak                             | Replaces the built-in GODMODE and depth directive with Chinese translations. Phrasing and training-data differences may weaken the jailbreak, so it is off by default. L1B3RT4S combos stay in English.                                                                                                                                                                                                                      |
| Disguise historical thinking             | Settings → Jailbreak                            | Folds the **previous** reply’s thinking into the historical assistant text so the server does not drop it; only the last historical round is converted and token usage rises slightly.                                                                                                                                                                                                                                       |
| Long-chat compression                    | Settings → Model (auto) + stats dialog (manual) | Auto: once context pressure reaches 80% of the window (after the 64k headroom and output reserve) with at least 2 new rounds since the last compression, older content is summarised in the background. Manual: "Compress older messages" in the stats dialog, always keeping the last 2 rounds verbatim. The summary is injected as a `latest_reminder`; local history is untouched and the summary can be cleared anytime. |

---

### 3.15 Branch to a new chat

Use the session menu (⋯ → **Branch to new chat**) or the button in the desktop session header to copy the current visible branch into a **brand-new chat**:

- The new session id and every message id are regenerated; the original chat is untouched;
- The current system prompt (lab combo) and compression summary are inherited;
- The new title carries a " (branch)" suffix, and both lines evolve independently;
- Branching is disabled while generating, importing, or before the session loads.

This is different from the in-session branch switcher (which keeps alternative answer versions inside one chat): here you get a separate line in the session list.

---

### 3.16 Model switching and per-model billing

The leftmost control in the input toolbar is the model card, with **DeepSeek Flash** and **DeepSeek V4 Pro** built in:

- Open it to see each model's cache-hit / input / output price per 1M tokens (off-peak; peak ×2);
- "Fetch from cloud" calls `GET /models`, then the Anthropic prefix `/anthropic/v1/models`; fetched models are cached for an hour and their ids are passed through to requests;
- A switch affects only new replies: old replies keep their own model, continuations keep the original model, and statistics/cost are computed per reply;
- The context ring uses the current model's window; models without a price entry fall back to Flash rates and a 128k window;
- On mobile the model picker stays expanded with the current model name and dropdown arrow; only the other input controls collapse to circles;
- Settings → Model shows the current model; restoring defaults resets it to DeepSeek Flash.

Prices (yuan per million tokens, off-peak; peak ×2):

| Model             | Cache hit | Input (miss) | Output |
| ----------------- | --------- | ------------ | ------ |
| `deepseek-flash`  | 0.02      | 1            | 4      |
| `deepseek-v4-pro` | 0.15      | 4.5          | 13.5   |

The billing section in the stats dialog gains a "By model" breakdown with reply counts and cost per model.

**Local models (2.7.4)**: the top group of the model list holds downloaded WebLLM models and MLC-LLM API models:

- Selection values use the `webllm/<model_id>` and `mlc/<model_id>` prefixes; anything else still goes to the cloud API, and a switch only affects new replies;
- Local tokens cost nothing and do not consume the daily token quota, while speech synthesis, speech recognition, document parsing and server search are still billed (statistics show "Local · free" per model and a zero-cost local-token line in the cost breakdown);
- Local models need no DeepSeek API key, so the composer no longer sends you to "enter an API key";
- Local models take text only: attachments are skipped with a one-time notice, and the session title is derived from the question.

See 3.31.

### 3.17 Long-term memory and daily usage

**Long-term memory** (Settings → Memory):

- Add / edit / enable / delete / clear entries manually; enabled entries are injected into every request's `system`;
- With **auto-extract** on, one extra Flash call after each turn turns stable facts, identity and long-term preferences into JSON operations (small extra cost, off by default);
- Memories stay on this device and are not part of history exports; enabled entries also sync into the memory graph as `saved` nodes.

**Daily usage and alerts** (Settings → General):

- Tracks today's `input + cache_read + cache_creation + output` tokens and cost at each model's peak/off-peak rates;
- Optional daily token and cost limits; crossing one shows a toast once per day and never blocks requests;
- The stats dialog shows today's tokens and cost, with a reset button.

### 3.18 Memory graph (ported from Operit)

Settings → Memory → **Memory graph**:

- Nodes carry a title, content, tags, importance and credibility; a new node is auto-linked to up to 3 similar nodes by local hashed-vector cosine similarity;
- Retrieval combines keyword, tag, vector and weighted edge expansion; all four weights, the relevance threshold and the number of results are configurable;
- Vector dimension can be 64 / 128 / 256 / 384 / 768 (default 256), generated locally without an embedding service;
- **Search debug** shows each candidate's keyword / tag / vector / edge score, total, pass flag, plus node/edge counts, match counts and edges traversed;
- At request time the top N matches are injected into `system` together with long-term memory; no matches means no injection;
- Import/export a JSON archive of long-term memories plus graph nodes/edges; import can merge (content-deduplicated) or replace;
- The relation graph draws nodes and weighted edges; click a node to inspect its content and tags; on mobile it keeps a readable size and scrolls horizontally;
- Shows the current vector dimension, node count, average degree and estimated Float32 footprint; search debug adds dimension, query-token count and top score;
- Chat statistics and the input context ring show memory nodes/edges/dimension/last injected hits; restoring defaults resets retrieval settings and daily alerts but keeps saved memory data;
- On mobile the weights become single-column, the search-debug table scrolls horizontally, and nodes/tags wrap.

### 3.19 Locations: clear, custom and off-world

Settings → General → Location:

- When a location is set, a **Clear location** button removes it;
- A free-form input next to the selects accepts any place (for example “Paris” or “Zhongshan Station, Antarctica”); press Enter or leave the field to apply;
- A custom location takes precedence over administrative and special choices and is written directly into `latest_reminder`;
- Special locations: Space Station (Satellite / Station), Moon (Near Side / Far Side) and Mars (Spacetime Management Center);
- Special locations override the administrative selection; custom and special locations only affect `latest_reminder`, not weather, web search or server-side region detection.

### 3.20 Search poisoning

Settings → Search poisoning. This group exposes every search input the client can control:

| Capability       | Behaviour                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Current time     | A `datetime-local` value injected as the model’s date and weekday; empty uses the real time                                                    |
| Knowledge cutoff | Declares the model database / training-data cutoff; empty means no declaration                                                                 |
| Search takeover  | With custom results, `deepseek_web_search` is not declared and the model only sees the filtered local results; turn it off to keep real search |
| Replacement      | Keyword or regex replacement by URL / title / snippet / all fields; regex supports `$1` groups                                                 |
| Blacklist        | Matching results are removed from the UI, exports and model context; forces takeover                                                           |
| Forced results   | Custom results are injected and shown as search results regardless of real search hits                                                         |
| Whitelist        | Only custom results matching the whitelist are returned; all server results are withheld                                                       |

- The engine lives in [`src/services/searchPoison.ts`](../../src/services/searchPoison.ts): replacement, blacklist and whitelist run before injection; at most 50 rules and 20 custom results;
- Custom results go into `system`, so long snippets increase input tokens; each snippet is capped at 4000 characters;
- Takeover mode: `tools` only keeps `deepseek_read_url`, `system` gains a `[LOCAL SEARCH LAYER]` block, and a “poisoned search” step is added to the reply timeline; the bottom web summary opens it;
- Non-takeover mode: real server search stays; result blocks are replaced / filtered as they reach the client and citation markers follow, but results already consumed by the server cannot be retracted;
- The custom time goes into the `latest_reminder` date, weekday and location; the knowledge cutoff and search results go into `system`; UI time, billing, weather and geolocation stay unchanged;
- Compatible with anti-retraction and stream output: only request context and result display change; refusal handling is untouched, and with streaming off the poisoned step appears once at completion;
- Everything is stored under `chat-demo:search-poison` and reset by Restore default settings; takeover means no real web search, so turn it off (or clear blacklist / whitelist) when real search is needed.

### 3.21 Attachment poisoning

Settings → Attachments → Attachment poisoning. Off by default; when enabled, attachments are rewritten locally before upload so the model sees your text when it reads them.

| Method                        | File types                                     | Behaviour                                                                              |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| Text body injection           | TXT / MD / CSV / code / HTML / JSON            | Inserts text with an `[ATTACHMENT NOTE]` marker before or after the body               |
| DOCX body injection           | `.docx`                                        | Unzips the file and appends a paragraph to the end of `word/document.xml`              |
| Image text overlay            | PNG / JPG / WebP / GIF and other raster images | Draws a text panel at the top or bottom for vision / OCR                               |
| Image metadata (experimental) | JPEG / PNG                                     | Writes a JPEG COM or PNG tEXt comment; some extractors read it                         |
| File trailer (experimental)   | PDF / unknown binary                           | Appends text at the end; ZIP-based Office files are skipped                            |
| Filename injection            | Any format                                     | Puts the first 40 characters into the upload filename; works when the model can see it |
| Companion text attachment     | PDF / Office / any format                      | Adds a separate `.txt` to the message; most reliable, but uses one attachment slot     |

- Methods can be combined; only those that fit the file type are applied, and failures fall back to the original file without blocking the upload;
- Content is capped at 4000 characters and wrapped in an `[ATTACHMENT NOTE]` marker; text, DOCX and the image panel go before or after the body;
- The original file stays in IndexedDB and the processed copy is uploaded; re-uploading can apply a new configuration;
- After a settings change, the next send re-uploads attachments in the input box that still have a local original; attachments already sent are not rewritten, and imported files without a local original stay as-is;
- Enabling / disabling or toggling the companion attachment immediately re-uploads the originals in the input box; companion text attachments sync when enabled / disabled, and should be re-selected after content changes;
- Restoring defaults disables and clears the config and removes automatically generated companion attachments from drafts;
- Image text overlay re-encodes the image: GIF / animations become static and GIF / BMP may become PNG; prefer the companion text attachment for PDF / Office.

### 3.22 Custom chain of thought

**Where:** Settings → **Chain of thought**. Off by default. When enabled, the reasoning steps you write are injected as a separate system block on every request, so the model follows your order instead of a vague “think step by step”.

The text is pre-filled with the built-in `thinking_prompt`: a fresh install, “Insert default prompt” and Restore defaults all use it, and it stays fully editable in settings or the composer card.

| Deep thinking   | Injected block                             | Behaviour                                                                                                                                 | Stability    |
| --------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Off (level 0)   | `[CUSTOM CHAIN OF THOUGHT]`                | The model reasons internally through the steps; an “Injected chain of thought” card appears above the reply, followed by the final answer | Standard     |
| On (levels 1-4) | `[CUSTOM CHAIN OF THOUGHT · EXPERIMENTAL]` | Guidance for server-side reasoning; the server may ignore, adjust or rewrite the steps                                                    | Experimental |

- The composer is now two rows: model / auto jailbreak / perturbation on the first, chain of thought / web search / deep thinking on the second; mobile keeps a single horizontal row.
- The composer **Chain** button is a card, sharing the same config as the settings page: toggle, edit, insert an example, clear, or open the full settings for the system preview.
- **With deep thinking off, an “Injected chain of thought” card is rendered above the reply** (expanded by default, collapsible). It shows the exact steps written into system for that turn instead of showing only the final answer; it is user-defined input, not server-side thinking.
- With deep thinking on, the card is not repeated; server-side thinking is shown as usual, and the custom chain remains experimental guidance.
- Each reply stores a snapshot of the injected chain: continue reuses it, regenerate reads the current settings, so changing settings mid-conversation cannot make one turn inconsistent.
- The block sits after the Persona / unrestricted rules and before long-term memory and search context. The first request also asks for a title, and still gets the block; otherwise the first reply in a new chat would not use it.
- The text is capped at 4000 characters and stored locally in `chat-demo:custom-cot` and `chat-demo:custom-cot-enabled`; every request increases input tokens.
- Turning the switch off keeps the text for later; restoring defaults clears it and disables the feature.
- Only `system` changes. Streaming / non-streaming, continue, regenerate, title generation, attachments, search poisoning and history import/export stay compatible.

### 3.23 Statistics, charts and context management

**Where:** Settings → **Statistics**, plus the stats dialog in the composer toolbar.

- **Usage ledger** (`usageLedger`): every finished request is written into a day / model bucket with uncached input, cache read, cache write, output, estimated cost, request count and web searches. The ledger keeps the last 400 days in localStorage, never stores message text, and is separate from the today-only daily usage that drives the quota reminders.
- **Range switch**: today / 7 days / 30 days; missing days are filled with zeros so the chart always has a continuous axis.
- **KPI band**: total tokens, estimated cost, cache hit rate, requests, days with usage, web searches.
- **Daily trend bars**: switchable metric — tokens (with cost as the second bar), cost, or request count — one bar pair per day, with a hover tooltip carrying the exact numbers.
- **Activity heatmap**: the last 8 weeks, one cell per day, four intensity steps relative to the busiest day in the window.
- **Hourly distribution**: all 24 hours of the range on one axis, so you can see when you actually chat; the note names the busiest hour.
- **Input composition ring**: uncached input / cached input / cache write / output, each with tokens and share, so it is obvious which part drives the bill.
- **Per-model split**: requests, tokens and cost for each model seen in the range; unknown ids fall back to Flash prices.
- **Session ranking**: the busiest sessions in the range by tokens, with cost and request count; **Open** jumps straight into that session (disabled once the session is gone).
- **Auxiliary usage**: web searches, parsed document pages, TTS characters and ASR seconds — the parts of the bill that token counts do not cover; local models only zero out token costs, these extras are still billed.
- **Context statistics management**: the current session's context against the model window and the compaction threshold, then a table of tracked sessions with context size, window share and last request time. Clear a single record, clear all records, export the ledger as JSON or CSV, or wipe the ledger entirely.
- **Ledger v2**: per-day records now also carry an hourly histogram and a per-session breakdown. Older v1 ledgers are read with the missing fields defaulted, so upgrading never needs a migration script; corrupt JSON is treated as an empty ledger instead of crashing the page.
- **Context breakdown**: the latest request of the session is split into system prompt, tool definitions, user messages, model replies, model thinking, tool calls, tool results and attachments, each with estimated tokens and share. Estimates use character weights, so server-reported numbers in the KPI band remain the authoritative ones.
- **Billing rates**: the model's miss / hit / output prices (CNY per million tokens) plus search, document parsing, TTS and ASR unit prices, with the peak-hour doubling rule spelled out — handy when a bill looks unexpected.
- **Free server search**: under the official policy effective 2026-11-18 12:00 Beijing time, server-side search and page fetch triggered by model calls are no longer billed — only tokens are. The switch defaults to on; turn it off to estimate at the old rate (CNY 5 / 1000 calls) when reconciling older bills.

**The composer stats dialog** now also carries the per-session output trend (sparkline plus latest / average / longest), the last-7-days app-wide trend for comparison, the input composition ring, an auxiliary card (searches, fetches, parsed files and pages, TTS characters, ASR seconds), and a pressure gauge with remaining window and compaction threshold; its footer jumps straight into Settings → Statistics.

**API key masking:** the jailbreak lab no longer renders the full key. It shows `sk-****` plus the last four characters, and a “Change in Settings” link that opens Settings → Data, matching how the data section itself masks the saved key.

> What is actually sent is also gated by the composer’s chat mode: Chat only sends none, Web agent sends browser + workspace, PTC / Creator add NanoVM and WebVM. See 3.27.

### 3.24 Browser agent tools

**Where:** Settings → **Browser tools**. Ported from `DeepSeek-Agent`'s browser and widget tools — browser-only capabilities; MCP tools, subagents and workspace (desktop) tools are deliberately left out.

| Tool                 | What it does                                                                     | Notes                                 |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| Date & time          | Localised date, ISO time, weekday and zone offset; accepts an IANA zone          | Safe, no network                      |
| Location             | Latitude / longitude, accuracy and a reverse-geocoded city                       | Browser permission prompt             |
| Weather              | Open-Meteo current conditions plus a 1–7 day forecast, by city or coordinates    | No API key; falls back to geolocation |
| Notification         | System desktop notification                                                      | Asks for permission the first time    |
| Read clipboard       | Returns clipboard text                                                           | Asks for confirmation                 |
| Write clipboard      | Copies text to the clipboard                                                     | Writes to the device                  |
| Fetch webpage        | Downloads a page and extracts readable text, cap on characters                   | Subject to the target site's CORS     |
| Create file          | Produces a previewable, downloadable file (Markdown, HTML, CSV, JSON, SVG, code) | Asks for confirmation; stored locally |
| Open link            | Opens a URL in a new tab                                                         | May be blocked by popup rules         |
| Visualization widget | Renders a self-contained interactive HTML component in a sandboxed iframe        | Sandbox has no same-origin access     |

- **Every tool has its own switch.** With the master switch off nothing is declared; with one tool off the model never sees it, and a call from history is refused at execution time with an explanatory error instead of running.
- **Tool round trips** happen inside one reply: the model emits `tool_use`, the page executes it, the result goes back as `tool_result` and generation continues (up to four rounds). Each round is a real request, so tokens are billed per round.
- **Cards** show the tool name, an input summary, status and duration, with the raw input and result available on expand. Artifacts render below: files get preview and download, widgets are rendered live in a sandbox iframe that can run scripts but cannot read the chat page.
- **Approvals**: reading the clipboard and creating files pause for a confirmation dialog with the exact input; “allow for this conversation” remembers the decision. Refusal is returned to the model as an error result, so the reply never stalls.
- **Environment checks**: notifications, geolocation and clipboard availability are detected and surfaced in the settings header; unsupported capabilities are disabled rather than failing at call time.
- Everything runs locally: tool results and artifacts live in the reply on this device, and history exports contain neither.

### 3.25 Virtual workspace

**Where:** Settings → **Workspace**. A file store that lives entirely in browser storage — no backend, no real disk — so the agent has somewhere durable to keep notes, reports and generated files across conversations.

| Piece           | Behaviour                                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files           | Any format: text files can be created and edited inline (renaming by editing the path), while images, PDFs and archives are stored byte-for-byte; everything can be deleted, previewed and downloaded                                                             |
| Limits          | Measured in bytes: OPFS scales with the browser's real quota (up to 80% of it, capped at 64 GB total / 256 MB per file), while localStorage is bounded by the browser's 5–10 MB with a 4 MB per-file soft cap; the page shows live usage and the effective limits |
| Import / export | “Import files” accepts any format (multi-select); “Export ZIP / Import workspace” round-trips everything with binary intact; legacy JSON backups still import. Archive import can merge (same paths overwritten) or replace                                       |
| Paths           | Relative only; `..`, absolute paths and drive letters are rejected so keys stay sane                                                                                                                                                                              |
| Workspace tools | `list_workspace`, `read_workspace_file`, `write_workspace_file`, `diff_workspace_file`, `delete_workspace_file` — writes and deletes require confirmation, and the diff compares against the content a file had when it entered the workspace                     |
| Storage         | Browser localStorage (default) or the **OPFS file system**, switchable at any time; switching copies the current files to the new backend                                                                                                                         |
| Persistence     | “Request persistent storage” calls `navigator.storage.persist()` and the page shows whether it was granted plus used space and quota                                                                                                                              |
| Defaults        | **Off.** Both the agent master switch and the workspace switch start disabled, so a fresh install declares no tools at all                                                                                                                                        |

- Turning the workspace off hides every workspace tool from the model even if the agent master switch is on; a call from history is refused at execution time.
- Nothing here is uploaded. History exports do not include the workspace, so export the archive yourself before clearing browser data.

### 3.26 NanoVM Slim (a WASM shell in the browser)

**Where:** the **NanoVM Slim** entry at the bottom of the sidebar (above “Lab” and “Settings”) opens the terminal; the console lives in Settings → **NanoVM Slim**.

A lightweight POSIX environment running inside the page: a WASM Shell Engine plus a busybox-style command set, with no backend and no real disk — the files live in browser storage.

| Piece                | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine               | The engine chunk is only fetched when a command first runs (or when you open the terminal with “load on first use” on), so the first paint stays small. It instantiates WASM linear memory at the configured size and runs pipeline buffers through it; going over the quota returns `Cannot allocate memory`                                                                                                                                                                                                                                                                                                                           |
| Terminal             | Docks to the right of the chat on desktop (420 px by default, drag to resize; turn “dock on the right” off to float it). On phones it is a bottom panel that fills the space above the keyboard, resizes by dragging and goes fullscreen; tabs, ↑↓ history and Ctrl+C are supported                                                                                                                                                                                                                                                                                                                                                     |
| Switch keyboard      | The keyboard button in the mobile input row opens the system input-method picker (the APK routes it through the native `InputMethodManager`), so you can change keyboards without leaving the terminal. Plain browsers cannot do this and get a shortcut hint instead                                                                                                                                                                                                                                                                                                                                                                   |
| Reset                | A red “Reset” in the desktop header and the mobile toolbar: after a confirmation it clears every file in the VM and restarts the engine (the console in settings can reset too)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| busybox              | 130 built-in commands: files and system (`ls cat cp mv rm mkdir rmdir touch ln stat chmod du df ps free env export which` …), text (`grep sed awk sort uniq cut tr wc nl rev tac paste find xargs tee` …), bytes and data (`sha512sum strings hexdump xxd od column fold expand unexpand numfmt cmp base32`, a `jq` subset, `zip unzip split shuf join comm`, `basename dirname realpath readlink mktemp nproc timeout`, developer tools `patch bc expr tree fmt time uuid getopt tsort envsubst dotenv sponge`), archives and hashes (`tar gzip gunzip sha256sum md5sum base64 cksum diff`) and network (`curl wget`, subject to CORS) |
| Networking           | `wget` / `curl` / `ping` add `https://` when the scheme is missing; the **APK routes through its built-in proxy** (a local 127.0.0.1 reverse proxy that really issues the request with Android's `HttpURLConnection`, so WebView CORS does not apply), while plain browsers can only reach sites that allow cross-origin requests. Settings → NanoVM Slim → **Network proxy** can switch to direct or take your own proxy prefix (`{url}` placeholder)                                                                                                                                                                                  |
| Virtual network      | There are no sockets in a browser, so `vm serve <port> <command>` registers a service with the **CGI model**: `curl http://127.0.0.1:<port>/` runs the command once (request in env vars, body on stdin, response on stdout in CGI format). `serve <port> [dir]` starts a static site, `vm serve --ws` registers a single-message WebSocket (`wscat`), and Node `http` / `ws` plus Python `nanovm_serve` (Flask and other WSGI apps) sit on this network. No daemons or long connections; large responses are buffered                                                                                                                  |
| On-demand toolchains | Runtimes: Python 3 (Pyodide, ~12 MB), a Node.js-compatible runtime (nothing to download), Lua 5.4 (wasmoon, ~0.4 MB) and SQLite 3 (sql.js, ~1.3 MB); build tools: esbuild (~12 MB), TypeScript (tsc, ~9 MB), Sass (~5.8 MB), Terser (~1.1 MB), Prettier (~2 MB) and GNU make (built in); utilities: Git (built in)                                                                                                                                                                                                                                                                                                                      |
| Package commands     | `vm install python`, `vm uninstall python`, `vm list`, `vm info`, `vm mem`, `vm df`; install progress prints straight into the terminal and the model can call these too                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Console              | Switches (enable, allow the model, load on first use, desktop dock), memory and virtual disk quotas, command timeout, engine status, storage backend and usage, VM image import/export (zip), reset; toolchains are grouped into runtimes / build tools / command-line tools, and each card shows size, state, version and a copyable example command                                                                                                                                                                                                                                                                                   |
| Storage              | The virtual disk lives in OPFS (`chat-demo-nanovm`), falling back to localStorage; the exported zip carries a manifest plus the whole file tree and can be imported on another device                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Agent tools          | `nanovm_shell` (run a command, needs confirmation), `nanovm_ls` (read-only listing) and `nanovm_install` (install a runtime, needs confirmation); **off by default** — with the master switch or “allow the model to call the shell” off, the model cannot see them at all                                                                                                                                                                                                                                                                                                                                                              |
| Defaults             | NanoVM Slim enabled, **model access off**; 128 MB memory, 64 MB disk, 15 s command timeout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

- Commands in the terminal do not touch the network (except `vm install`, `curl` / `wget`, and the chat API itself).
- Chinese comments, UTF-8 file names, multi-line output, pipes and redirections all work; `&` background jobs are not kept (there is no job control).
- Installing Python needs the network once; afterwards it loads from the local cache. Node.js and Git are built in and work offline.

### 3.27 Chat modes (Chat only / Web agent / PTC / Creator)

**Where:** the mode chip left of the chain-of-thought chip in the composer, styled like the model picker, with a four-entry menu.

The mode only decides **which client tools are sent to the model this turn** — an extra restriction on top of the settings switches, never an override: a tool turned off in settings stays off even when the mode allows it.

| Mode          | Tools sent                                                                  | Client tool round trips | Extra behaviour                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chat only** | Server tools only (read URL / web search); no browser, workspace or VM tool | 4                       | Long-term memory, search poisoning and custom CoT keep working                                                                                              |
| **Web agent** | Browser tools + virtual workspace tools                                     | 8                       | Fetch pages, notifications, clipboard, workspace read/write                                                                                                 |
| **PTC**       | Web agent + NanoVM Slim / WebVM (shell / files / installs)                          | 16                      | Multiple tool calls in one round run **in parallel** and can build on each other                                                                            |
| **Creator**   | Same as PTC                                                                 | 24                      | The model may `vm install python`, write scripts into `/usr/bin` and `chmod +x` them into new commands; VM writes and installs **no longer ask every time** |

- The active mode is described to the model in the system prompt, so it does not keep trying tools it cannot use.
- If the model calls a tool the current mode forbids (for example from history), execution is refused with “the current chat mode does not allow this tool”.
- The default mode is **Web agent**, matching the previous behaviour once tools are enabled; the choice lives in `chat-demo:chat-mode`.
- The menu also warns when the mode cannot take effect yet (“browser tools master switch is off”, “workspace switch is off”, “NanoVM does not allow the model”).

---

### 3.28 In-app update check and Android storage semantics

**Where:** the “Check for updates” card in Settings → **About**; workspace storage status in Settings → **Workspace**.

| Piece             | Behaviour                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Update check      | Reads the latest Release of this repository from `api.github.com` and compares it with the version baked into the build; when newer, it offers a download button (the release `.apk` asset when present, otherwise the release page) plus collapsible release notes (first 500 characters) |
| Android hand-off  | Inside the APK it adds “install the APK over the current app” and opens the system browser instead of downloading inside the WebView                                                                                                                                                       |
| Storage semantics | The Android shell injects a `nanovm-app` meta into the page, so the workspace counts as **app storage** (not evicted with site data) and hides the “request persistent storage” button                                                                                                     |
| Quotas            | The Android shell defaults to OPFS with 90% of the quota (up to 2 GB per file, 20,000 files) and migrates old localStorage files on first launch; browsers keep 80% / 64 GB / 256 MB                                                                                                       |

- The check is a single anonymous GET against the GitHub public API — no API key, no other requests; failures are shown verbatim.
- Migration is one-way: after moving to OPFS the localStorage copy is cleared, and only switching back to “browser local storage” writes it again.

---


### 3.29 WebVM (CheerpX)

**Where:** the “WebVM” entry in the sidebar, or the “NanoVM Slim / WebVM” switcher at the top of the terminal panel; the WebVM card under Settings → **Virtual machines**.

**What it is:** the second terminal is not a simulated shell — it runs a real x86 Debian 10 on top of CheerpX, which JIT-compiles x86 into WebAssembly and executes actual Linux binaries in the browser. The root filesystem is an ext2 image streamed from `disks.webvm.io`; changes go into an IndexedDB overlay. The image ships bash, coreutils, gcc / g++, Python 3, Node.js, Ruby, Perl, Lua 5.3 / LuaJIT, make, git, vim, nano, curl, wget and more, so C/C++, Python and Node code runs out of the box.

| Capability        | Behaviour                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | First open loads CheerpX 1.4.0 from the Leaning CDN (~1 MB) and streams about 2 GB of Debian image blocks; later launches use the IndexedDB overlay and keep disk changes across reloads |
| Alongside NanoVM  | Both instances stay alive. Switching changes only the view — the WASM engine, the CheerpX processes, scrollback and files are untouched. Works in the desktop dock and the mobile sheet |
| Terminal          | xterm.js plus a real PTY: arrows, Tab, Ctrl+C / Ctrl+D, full-screen programs such as vim and top, and IME input all work; the toolbar has Esc / Tab / arrows / keyboard / import / export / environment check |
| Cross-origin      | CheerpX needs SharedArrayBuffer, which needs COOP/COEP. On static hosting the first enable registers `coi-sw.js` and reloads once; Android WebView does not support cross-origin isolation, so the APK points users to Chrome or a desktop browser |
| Images            | Debian 10 (2026-06 image) by default, the 2023 image as a fallback, or a custom `wss://` / `https://` / same-origin ext2 URL; each image gets its own overlay |
| Import            | Files are written to the read-only DataDevice under `/data` and copied into `/home/user/imports`; up to 50 files / 20 MB per batch |
| Export            | Runs `tar czf - -C /home/user . \| base64 -w0` inside the VM; the browser captures it and downloads `webvm-home.tar.gz` (32 MB cap) |
| Model access      | New `webvm_shell` / `webvm_ls` / `webvm_status` tools, in the same group as the NanoVM tools (only PTC / Creator send them); each run asks first, and Creator auto-approves |
| Environment check | “Check environment” in the settings card runs `uname`, `/etc/debian_version` and `command -v` for 24 tools, then prints what exists |
| Privilege escalation | WebVM runs as user by default; a sudo function is preinstalled (it calls the image's setuid `su`, root password `password`), `sudo -i` or the Root toolbar button enters root; root applies only inside the browser VM sandbox |

- **Why model commands do not use `cx.run()`:** a CheerpX Linux has a single console. Starting another process does produce output, but after it exits the interactive bash no longer receives stdin — typing appears dead. WebVM therefore writes model commands and import/export scripts to `/data/agent_xxx.sh` and runs them from the **existing shell** with `timeout N bash /data/...`, framing the output with begin/end markers.
- **Serialisation and timeouts:** model commands run one at a time; the tool timeout is 5 minutes (the first launch waits for image blocks), while a normal command gets 30–60 seconds. The timeout only guarantees the tool returns; a command that already started may still finish.
- **Network:** no network is configured by default (CheerpX networking needs a Tailscale login), so there is no `apt install` inside WebVM; the image already includes common toolchains. Use NanoVM's virtual network when you need HTTP services, or provide a custom image.
- **Licence:** CheerpX is proprietary software from Leaning Technologies; it is free for personal and open-source projects and needs a commercial licence otherwise. The settings card and docs keep the attribution and link.

---


### 3.30 Keyword refusal (ported from DeepChat)

**Where:** Settings → **Model** → the “Keyword refusal” group.

| Setting             | Behaviour                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable              | Checks the **user input only**; any matching keyword produces a completed refusal reply locally, without an API request                       |
| Keywords            | Newline or comma separated, substring match; an empty list disables matching                                                                  |
| Case sensitive      | When off, English keywords are compared in lowercase; Chinese is unaffected                                                                   |
| Custom message      | Text shown on a match; leave empty for the default `replyRefused` (“Sorry, that's beyond my current scope…”)                                  |

- **The local reply:** `status: 'done'`, `stopReason: 'refusal'`, with the text stored as a template block. There is no streaming caret, and it does not become context or a continuation prefix.
- **No API key needed:** the composer skips `ensureApiKey()` when a keyword matches, so the local refusal is written even without a key; other messages still require one.
- **Works with perturbation:** both the raw input and the transformed `content` are checked, so input perturbation cannot bypass a keyword.
- **Not a security boundary:** it is a local substring match, not semantic moderation; attachments, model output and image text are not inspected.
- Config lives in localStorage: `chat-demo:refusal-enabled` / `chat-demo:refusal-keywords` / `chat-demo:refusal-case-sensitive` / `chat-demo:refusal-message`.

---

### 3.31 Local models (ported from web-llm-chat)

**Where:** Settings → **Local models**, and the “Local models” group at the top of the composer model card.

Ported from [`mlc-ai/web-llm-chat`](https://github.com/mlc-ai/web-llm-chat): its model catalog, WebLLM inference, MLC-LLM API client and recommended sampling parameters are kept, rewritten as standalone services and a settings group for this project's static build.

**In-browser models (WebLLM)**

- The catalog comes from the installed `@mlc-ai/web-llm` `prebuiltAppConfig`, keeping only the models the current version supports (embedding models excluded); family, provider, parameter size, quantization, VRAM needs and recommended sampling values come from the ported `DEFAULT_MODEL_BASES`;
- Inference runs in a Web Worker (`src/services/local/worker.ts`); the main thread only receives progress, so weight downloads, wasm compilation and GPU setup happen in the background;
- “Download” is also “load”: weights and tokenizer go into the browser Cache Storage (`webllm/model`, `webllm/config`, `webllm/wasm`) and survive a page reload; “Use” writes the model into `chat-demo:model` and the chat bar reflects it immediately;
- Model caches can be deleted; switching the cache backend (Cache Storage / IndexedDB) unloads the current model and leaves downloaded weights in the previous backend;
- The context window follows the model recommendation (4K / 8K / …) or can be pinned from 1K to 128K; temperature, Top P, max output tokens, presence / frequency penalties and Qwen3 thinking mode all live in settings, and switching models applies the official recommended values first;
- Auto-load on page open puts the last used in-browser model back into GPU memory after a reload; failures stay silent and are explained in the settings card;
- "Restore defaults" also resets local model preferences (cache backend, context window, sampling, MLC endpoint, auto-load) and unloads the resident model; downloaded weights are kept and can be selected again from the catalog.

**MLC-LLM API**

- Enter the address of a self-hosted `mlc_llm serve` instance (default `http://127.0.0.1:8000`); “Connect” reads `GET /v1/models`, and selecting a model streams from `POST /v1/chat/completions`;
- It shares the same message pipeline as in-browser models: generation is wrapped into the same `MessageStreamEvent` stream as the cloud API, so streaming rendering, stop, statistics and Markdown all behave identically;
- No WebGPU is needed, which suits phones and the APK; attachments are text-only here as well.

**Bundle import / export**

- Export writes `.mlcmodel`: file bytes followed by a footer JSON and its length; the footer records each file's URL, cache scope, offset and size. With File System Access support the bundle streams straight to disk, otherwise it falls back to a Blob download;
- Import slices the file by offset and writes each segment back into Cache Storage, so multi-GB weights never have to fit in memory; the cache is verified right after import and the model appears in the chat bar;
- Only the Cache Storage backend is supported; with IndexedDB the buttons are disabled with an explanation.

**Measured (2026-11, Intel Arc B390 / Chrome + WebGPU)**

- The catalog holds 161 chat models; downloading and loading `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` (277 MB of weights plus a 5.7 MB wasm) took 57 s, moving from "Preparing the model…" to "Resident in GPU memory";
- "1+1 equals?" answered "2" in about 2 s; a three-sentence self-introduction produced 64 output tokens in about 3 s including prefill (~21 tok/s);
- Exporting the `.mlcmodel` bundle wrote 277.4 MB across 12 files covering all three cache scopes in about 1 s; importing it into a brand-new browser profile immediately showed "Downloaded" and answered "9" with no network attached, only local requests and zero `api.deepseek.com` calls;
- Usage accounting: one Qwen2.5-0.5B turn used 192 input / 64 output tokens with `billed 0` and `cost 0`.

**Local model enhancements (2.7.5)**

- **Auto memory**: Settings → Memory gains an extraction-model selector — follow the current model, force the Flash API, or force a local model. By default cloud chats use Flash and local chats use the local engine; cloud chats can also use the last selected local model, and local chats no longer have to call Flash. Local extraction works without an API key;
- **Thinking merge**: the local model thinking switch is now the composer's Deep thinking control — level 0 is off and levels 1–4 enable thinking for Qwen3; WebLLM receives `enable_thinking` and the MLC-LLM API forwards the same field when the server supports it;
- **Web search (experimental)**: with Smart search on and an API key configured, a DeepSeek server-side pre-pass fetches search highlights and sources, injects them into the system prompt, then the local model answers; without a key the search is skipped with a toast;
- **Text attachments (experimental)**: local models bypass the Files API; on send the page reads txt / md / csv / json / code attachments as plain text (8K per file, 24K total) into the system prompt; images and binary files are skipped with a notice;
- **Chat-only mode**: Agent / PTC / Creator are disabled while a local model is selected, so tools the model cannot run are never sent.

**Differences from cloud models**

- Local models send no client tools (Agent / PTC / Creator disabled); search is a pre-generation server-side pre-pass rather than a model tool call;
- There is no server-side refusal verdict: `stop_reason` is mapped from finish_reason (`length` → `max_tokens`, `content_filter` → `refusal`);
- Usage comes from the engine's prompt / completion tokens, costs zero, and the daily token quota only counts cloud models through the new `billedTokens` field.

---

### 3.32 Merging upstream chat-demo 0.1.3

Upstream 0.1.3 contains one attachment safety fix (`b53b77f`): before reusing a Files API image `file_id`, check the local original against the 4096 px long edge; oversized images are resized on re-upload, and stale oversized ids in old sessions are cleared and re-uploaded.

How it was merged without breaking this fork's attachment pipeline:

- New `src/utils/resizeUploadImage.ts`: decode the image, scale the long edge to 4096 px, keep JPEG / WebP, otherwise encode PNG;
- `uploadFile` resizes only images (`purpose === null`); documents and text attachments are untouched;
- `FileAttachment` gains `imageSizeChecked`, set for successfully uploaded draft images;
- `prepareFiles` calls `checkImageFileIds` before re-uploading, clears oversized stale ids and writes them back to the session, then lets the existing upload path run; the fork's poisoning fingerprints, attachment import/export and local-model attachment handling are preserved.

### 3.33 Features ported from Remember (2.7.5)

Based on [luomiluomi/Remember](https://github.com/luomiluomi/Remember) (MIT), rewritten for this fork's zustand + IndexedDB architecture rather than copying its Flutter / web styling:

- **Characters**: `src/services/companion.ts` stores role cards (name, gender, persona prompt, avatar, auto memory); manage them under Settings → Characters, switch via the composer chip, and sessions record a `roleId`; the persona and user salutation are injected into the system prompt while the default DeepSeek role keeps the native style;
- **My profile**: name and avatar in general settings, device-only; the name is injected as the user salutation;
- **Compression threshold**: Settings → Model gains a threshold selector — follow context pressure, or 32K / 64K / 128K / 256K / 512K / 800K; auto-compress triggers at that token count while keeping the existing round-count guards;
- **Account & usage**: Settings → Account & usage queries the DeepSeek balance (`/user/balance`) and shows today's tokens / cost, last-30-day tokens / cost / requests, searches, parsed pages and voice usage, reading the same daily usage and ledger as Statistics, with a shortcut to the Statistics tab;
- **Not ported**: app icon and name, appearance and colour schemes, chat font size and other cosmetic options; characters and profile use `chat-demo:roles`, `chat-demo:active-role` and `chat-demo:profile-*`.

> Character, profile, compression-threshold and account/usage interactions are inspired by Remember — with thanks.

### 3.34 Multiple system-prompt and chain-of-thought presets (2.7.5)

**Where:** Settings → Jailbreak (system prompt presets) and Settings → Chain of thought (CoT presets).

- **Save several variants**: each preset has a name and body, up to 30; New saves the current editor content, Clone duplicates the active preset and names it "copy";
- **One-click switch**: clicking a preset chip writes its content back to `settings.systemPrompt` / `settings.customCot`, taking effect on the next request; system prompts also offer "Auto-composed" to disable the custom prompt;
- **Edits sync**: editing the body while a preset is active updates that preset; rename and delete live in the bar, and deleting the active preset clears the current content;
- **Migration**: the first time settings open, existing custom prompt and CoT are each wrapped in a preset so nothing is lost;
- **Restore defaults** clears the preset library too;
- **Storage**: `chat-demo:system-prompt-presets`, `chat-demo:cot-presets` and two active ids stay on this device and are not part of history exports.

### 3.35 NanoVM single-file import (2.7.6)

**Where:** Settings → Virtual machines → "Import a single file", and the `nanovm_import` agent tool.

- **User import**: pick any single file from this device (zip / images / binaries) or from the workspace list; the target directory defaults to `/home/user` (or `/tmp`); same names are renamed to `name-2.ext` unless "Overwrite same name" is on;
- **Direct write**: files are no longer base64-encoded into shell commands. The page reads the `File` / workspace bytes and calls `vmFs.write()` then `persist()`, so a 46 MB file needs no dozens of command round trips;
- **Auto-grow**: the default disk is 64 MB with a 32 MB per-file cap. Before writing, the disk quota is raised to fit the file plus current usage (up to 2048 MB, hard per-file cap 256 MB), and the toast reports the new size;
- **Agent tool**: `nanovm_import` accepts `workspace_path`, or `content` with `encoding=text/base64`; `target` can be a directory or full path and `overwrite` controls replacement; like shell / install it asks for confirmation (auto-approved in Creator mode);
- **Visibility**: writes call `vmFs.emit()` and persist immediately, so `ls` / `wc -c` show the file at once and the usage bar refreshes.

### 3.36 NanoVM toolchain: PyBot (2.7.6)

**Where:** Settings → Virtual machines → toolchains → PyBot, or `vm install pybot` in the terminal; requires Python first.

- **Source**: a bundled snapshot of [huggingface/pybot](https://github.com/huggingface/pybot) (bot source commit `24cbc04`, Apache-2.0) packed as `public/pybot.zip` (~13 MB) and unpacked offline into `/opt/pybot`, so no network is needed at install time;
- **Contents**: 528 Python files, roughly 640k lines of rules, no weights and no third-party dependencies;
- **Interactive mode**: run `pybot` / `pybot -i` (or with `-v`) directly in the terminal for a continuous chat; the prompt becomes `user>`. `/reset` clears the context, `/help` lists commands and `/exit` returns to the shell. The session stays in memory instead of reloading each turn;
- **One-shot mode**: `pybot -p "question"` for one reply, `echo "question" | pybot` for line-by-line piping, `-v` for the module and timing, `--version` for the snapshot commit;
- **How it runs**: normal `python3` sync is capped at 16 MB, while PyBot raises the cap to 64 MB, syncs `/opt/pybot` into Pyodide and runs `pybot.py`; installation grows the virtual disk to about 83 MB automatically;
- **Measured**: Python install ~23 s (12 MB Pyodide), PyBot unpack ~3 s; interactive startup is about **6–8 s** and each turn takes 2–5 s. After “my name is Sam”, asking “what is my name?” answers “You're Sam.”; `/reset` then answers “I don't know it yet”. One-shot and piped modes work as well.

### 3.37 Settings regroup, memory notice, avatar crop and Android composer (2.7.7)

**Reference:** the memory-update notice, composer "+" tray, avatar crop dialog and sidebar motion of [DeepChat](https://github.com/xiaohuangbo/DeepChat).

- **Settings regrouped**: the old Prompt and Advanced pages become one Jailbreak page — unrestricted mode, prompt presets, auto jailbreak, Chinese jailbreak prompts, per-round injection, thinking-as-body, anti-retraction, skip safety check, continue refused replies, input obfuscation, AutoTune, output shaping, the custom system prompt and its full preview now live together; attachment poisoning moves into Attachments and no longer has its own nav entry;
- **Memory-update notice**: when auto-extraction adds, replaces or forgets a long-term memory, a toast shows what changed (trimmed to 60 characters); Settings → Memory gains "Show a toast when memory updates", on by default, off means silent saving;
- **Circular avatar crop**: My profile and character avatars share a new crop dialog — drag to pan, slider to zoom (1–4×), everything outside a circular hole is dimmed, and the result is a 384×384 JPEG; square originals are no longer stuffed into a round avatar slot;
- **Android composer**: inside the APK the paperclip becomes "+", expanding a camera / photos / files tray below the composer with expand and icon-rotation animations; desktop web and mobile browsers keep the paperclip. The APK camera uses the system `ACTION_IMAGE_CAPTURE` into an app-cache content:// URI and returns it to WebView, so no storage permission is needed;
- **Sidebar motion**: the mobile drawer is ported from DeepChat — the sidebar sits under the main view, which slides right to reveal it, with horizontal dragging from the middle or edge and velocity/distance thresholds; the corner radius and shadow follow the drag. On desktop the expanded sidebar slides in slightly and the collapsed button group fades down;
- **Version**: `2.7.7` / versionCode 277, the APK is signed with `xiaohuangbo.jks`.

### 3.38 DeepSeek V4 Pro request fix (2.7.8)

**Problem:** after selecting `deepseek-v4-pro`, sending a message returned:

```text
The server-side tool calls (deepseek_web_search, deepseek_read_url) and the title generation feature are unavailable for model deepseek-v4-pro. Please use deepseek-flash instead.
```

While fixing it we found that V4 Pro also rejects the `latest_reminder` role with `The latest_reminder message is unavailable for model deepseek-v4-pro`.

**Cause:** the request builder attached the server-side read-link / web-search tools, `title: { enabled: true }` and `latest_reminder` messages to every cloud model, but V4 Pro does not implement those Anthropic extensions.

**Fix:**

- **Capability checks**: `supportsServerTools()` / `supportsServerTitle()` mark V4 Pro so `deepseek_web_search`, `deepseek_read_url` and `title` are never sent to it;
- **Reminder folding**: for V4 Pro the date / location snapshot and compression summary are folded into the leading `system` prompt, and historical `latest_reminder` messages are omitted from the request; Flash behaviour is unchanged;
- **Title fallback**: V4 Pro no longer registers as a title request, so usage accounting and long-term memory extraction are not skipped; new sessions take the first 24 characters of the first question as their title;
- **Search toggle**: under V4 Pro the "Search" toggle is dimmed and explains that Flash is required; Settings → Model now spells out that V4 Pro lacks server-side search, link reading, cloud titles and image input;
- **Verified**: with a real API key, normal replies, two consecutive turns and long-term memory extraction all complete without errors; request bodies contain no server tools, `title` or `latest_reminder`, while client tools remain available;
- **Version**: `2.7.8` / versionCode 278.

> V4 Pro's `input_modalities` is `text` only: the API accepts image blocks but the model cannot see them. Switch to DeepSeek Flash for images, web search or cloud titles.

[← 返回 README](../../README.md) · [全部文档](README.md)

### 3.39 Unkernel Linux and mobile WebVM input fix (2.7.9)

**Mobile WebVM drift.** When the soft keyboard opened, Chromium scrolled the page to bring xterm's hidden textarea into view; the fixed bottom sheet moved with it and the terminal appeared to drift. `WebVmTerminal` now focuses the textarea with `preventScroll`, resets the page scroll on the next frame and again after 120 ms, and does the same on a native textarea focus. Desktop behaviour is unchanged.

**Unkernel Linux.** A third VM, embedded from the upstream [unkernel](https://github.com/pithings/unkernel) page (MIT / GPL-2.0) under `public/unkernel/`, runs a real Linux 7.x kernel compiled to WebAssembly with an Alpine 3.24 aarch64 user space. The page is served same-origin in a full-screen iframe, so the host can reach its `window.KW.vm` handle. It exposes the complete upstream page: interactive terminal and windows, `apk`, networking over a Wisp proxy, Web Audio sound, framebuffer/evdev display, persistent IndexedDB disk, file import/export and the upstream settings/options UI.

- The app's Chinese **Settings → Unkernel Linux** section controls the iframe URL: enabled, Agent permission, memory, command timeout, network, sound, display, persistent data, Worker mode, CPU count and a custom Wisp endpoint.
- Networking now defaults to public Wisp proxies (`wss://anura.pro/` and `wss://wisp.mercurywork.shop/`, raced), because the upstream default accepts only localhost; a custom `wss://` endpoint can still be set in Settings.
- The page UI is fully localized to Chinese: status line, System / Guest / Environment / Kernel log / Errors / Keys panels, Options, About, launcher, preview, display controls, confirmations and shortcut help are Chinese; kernel output in the terminal is left untouched.
- The settings section gains a Files area: drop or pick local files to import into the guest (default `/mnt/workspace`, binary safe, overwrite toggle, batch progress), download guest files to the device, pack directories as `.tar.gz`, save exports to the chat workspace, and a Restart VM button.
- The chat workspace is exposed as a 9p file system at `/mnt/workspace` through a small adapter over `src/services/workspace/store.ts`; guest reads and writes are synchronized both ways.
- Ten Agent tools now join the existing VM tools: `unkernel_shell`, `unkernel_ls`, `unkernel_read_file`, `unkernel_write_file`, `unkernel_transfer` (workspace transfer), `unkernel_python`, `unkernel_info`, `unkernel_open`, `unkernel_restart` and `unkernel_status`. They open the iframe on first use, wait for the kernel, and run through `vm.exec()` without disturbing the interactive terminal.
- Both images are bundled: Alpine 3.24 (3.9 MiB) and Debian 13.7 (70 MiB); Settings and the page Options can switch between them. Debian ships glibc / apt for Docker and Node; with DSH go's 24 MiB static binary the APK grows to about 112 MB.
- Multi-CPU (SMP) is selectable from 1 to 4 CPUs; more than one needs cross-origin isolation, which the desktop static build enables once and reloads into Unkernel. Android WebView does not support it, so one CPU only.
- The former **DSH + dsh-TUI** demo is replaced by **DSH go**, a pure-Go build of DeepSeek Harness from `go-deepseek`: a 24 MiB static aarch64 binary that the page verifies by SHA-256 and pushes into the guest, with no Node.js, pnpm or 600 MB runtime. Its terminal is a Chinese REPL (`/help`, `/new`, `/session`, `/exit`) with a working `bash` tool (file tools stay fenced to the working directory; system facts go through bash); the first run asks for an API key and saves it to `~/.dsh-go/api-key`, and sessions live under `~/.dsh-go/sessions`.
- Settings gains a **data disk** size (8 / 16 / 32 GiB, default 8 GiB): the disk is sparse, so a larger size costs nothing up front; after a restart the page installs `resize2fs` (Debian `e2fsprogs`, Alpine `e2fsprogs-extra`) and grows ext4 in place, keeping existing data (grow only). The first growth takes about 30 s and needs network. The same row gains **Reset data disk**: after confirmation the iframe is unloaded, `kwdisk:kwdata-*` and `kwsnap:session-*` are deleted, and the next boot creates an empty disk from the template; the chosen size stays.
- NanoVM gains a built-in `fastfetch` command and WebVM's bash gets a `fastfetch` function showing OS, kernel, uptime, shell, memory and disk. The kernel (UP + SMP wasm, ~18 MiB) and the page assets are copied by rspack into `dist/unkernel/`; the Android asset server now answers HTTP Range requests, which unkernel uses to read the read-only image lazily.
- Requires JSPI (Chrome / Edge 137+, Firefox 153+, Safari 27+). Android WebView shows a boot error when JSPI is missing.

**Files:** `src/components/unkernel/`, `src/services/unkernel/`, `src/services/agent/unkernelTools.ts`, `public/unkernel/`, `rspack.config.ts`, `android/src/.../LocalServer.java`.

### 3.40 Large text attachments and import progress (2.7.10)

**The problem.** Plain-text attachments (txt / md / csv / json / code) are uploaded as documents, and the server counts the whole file as input tokens for that turn. Once a file is large enough (measured: 188 KB of English ≈ 44k tokens, 1.23 MB ≈ 290k, 4.87 MB ≈ 1.2M) it overruns the window: `This model's maximum context length is 1048576 tokens. However, you requested 1147064 tokens ...` — the "token too large" error users reported. Both Flash and V4 Pro declare 1,048,576 tokens of context and happily parsed the 300k-token document, so the failure is one file filling the window, not the file format.

**Settings → Attachments → large text attachments.** A new master switch makes the client decide locally at pick time through `src/services/attachmentLargeText.ts`: only plain-text files whose estimated tokens exceed 32768 are handled (CJK counts 1 token per character, everything else 4 characters per token — the same rule as the session statistics).

- **Split mode (default)**: split on line boundaries so each part stays under 32768 tokens (1024 tokens of headroom for the part header); over-long single lines are hard-split by binary search over characters. Parts are named `name.partN.ext` and start with `【附件分片 n/N：name】` so the model knows they belong together. All parts upload and send as separate attachments; measured with 8 parts (223k tokens total) in a single message, the request succeeded.
- **Experimental 1M context**: no split and no upload — the attachment stays in IndexedDB, `prepareFiles` reads the text into the request copy and `reply.ts` prepends it to the turn as a text block, consuming the model 1M context directly. Files above 1M tokens are refused at pick time with a hint to use split mode. The text is cached per attachment id (last 4), so later turns do not re-read large files.
- Split parts still obey the per-session file limit; excess parts are truncated with a toast. Attachments in the experimental mode show "In the 1M context" on the card instead of an upload state.

**Settings → Data → Import chat history progress bar.** `readArchive` learns the non-directory entry count from the central directory and reports after each consumed entry; `importArchive` adds the number of sessions written to staging and `backup.importHistory` forwards it to Settings. While importing, the status line shows the percentage above a 6 px bar with "Processed x / y entries · z chats imported"; the format check shows "Checking the file…", and the existing success/failure messages are unchanged.

**Files:** `src/services/attachmentLargeText.ts`, `src/services/chat/drafts.ts`, `src/services/chat/store.ts`, `src/services/chat/reply.ts`, `src/services/chat/types.ts`, `src/components/settings/SettingsDialog.tsx`, `src/components/files/FileCard.tsx`, `src/components/chatInput/DraftAttachments.tsx`, `src/components/chatInput/ChatInput.tsx`, `src/services/chat/history/{zipReader,importArchive}.ts`, `src/services/chat/backup.ts`.

### 3.41 The real cause of the attachment "token too large" error (2.7.11)

**Symptom.** After 2.7.10 split a 326 KB txt into four parts (96+96+96+34 KB), the request still failed:

```text
user input too long, 69942 tokens exceeds max 32768 tokens (request_id: …)
```

**Diagnosis.** A local logging proxy captured the exact request the app sends; removing fields one at a time and replaying gave:

| Request fields | Result |
| --- | --- |
| Original (tools + safety_check + title) | 400 `user input too long, 60753 tokens exceeds max 32768 tokens` |
| Without title | still 400 |
| Without safety_check | still 400 |
| Without tools | still 400 |
| Without title + safety_check (tools kept) | passes |
| Without all three | passes, `input_tokens` 64k, document text read correctly |
| Only tools / only safety_check / only title | each alone triggers the 32768 cap |
| Only thinking / temperature / top_p / max_tokens | no effect |

In other words: **whenever a request carries any of the DeepSeek extension fields `tools`, `safety_check` or `title`, the server caps "user input" (text plus parsed attachments) at 32768 tokens; a plain Anthropic-compatible request without them can use the full 1M context.** The same 60k-token body sent as plain text is rejected too, so neither the file format nor the part count matters. RikkaHub can read the same txt because it converts documents to prompt text and sends none of those DeepSeek fields.

**Fix.** Before assembling the request, `streamReply` estimates user input with `estimateUserInputTokens()` (history and question text plus attachments at 4 bytes per token). Above 32768 tokens it:

- stops sending `tools`, `safety_check` and `title`, so the request falls back to the plain Anthropic-compatible path and attachments can use the full 1M context;
- removes the turn's controller from `titleRequests`, so the turn's usage is still recorded instead of being treated as a title request, and titles the chat with the first 24 characters of the question;
- shows a toast the first time it happens, explaining that server tools, the safety check and the title request were dropped;
- catches a server `user input too long` 400 (when the estimate was too small) and retries once without those fields, only surfacing the original error if the retry fails too.

Small inputs are unaffected: below the threshold the request still carries the safety check, server tools and title request.

**Files:** `src/services/chat/store.ts`, `src/services/api/types.ts` (`tools` is now optional), `src/i18n/{zh,en}.ts`.

### 3.42 Non-Latin memory retrieval and tag graph expansion (2.7.12)

**Problem.** After 2.7.10, memory-graph retrieval never matched Russian (Cyrillic) or other non-Latin text: typing a word that appears verbatim in a node's title, content and tags still showed `query tokens 0`, `top score 0.00` and zero injected memories in Settings → Memory → Search debug.

**Cause.** `tokenizeMemory()` only recognised two scripts:

```ts
const words = lower.match(/[a-z0-9_.-]{2,}/g)
const runs = lower.match(/[\u4e00-\u9fff]+/g)
```

Latin went through the first pattern and Han through the second; everything else (Cyrillic, Greek, Arabic, Devanagari, kana, …) matched neither and was dropped, so both the query and the index produced zero tokens and nothing could ever match.

**Fix.** Tokenisation now uses Unicode rules:

- Han keeps the single-character plus bigram rules so Chinese recall is unchanged;
- every other script is kept word-wise with `[\p{L}\p{N}]+(?:[_.'’-][\p{L}\p{N}]+)*/u`;
- input is NFKC-normalised and lower-cased first, so full-width forms and input-method differences no longer break matching;
- Han runs are blanked before word matching so a character is not counted twice;
- the English / Chinese stop-word lists still apply.

With the fix, `Москва столица` yields `['москва', 'столица']`, one keyword match and a non-zero score; Chinese behaviour is unchanged.

**Tag linking & graph expansion (new switch).** Settings → Memory → "Tag linking & graph expansion", off by default:

- when on, nodes sharing tags are linked automatically on add/update with `type: 'tag'`, weight `0.2 + shared / larger tag set × 0.6` (capped at 0.9), at most 3 links per node so a large tag cluster cannot blow up the edge count;
- search keeps the vector-edge expansion and adds dynamic tag expansion: seed nodes pass a share of their score to nodes sharing tags, so neighbours added later by tag edits or archive imports are still pulled in;
- when off, `type: 'tag'` edges are ignored during expansion and retrieval behaves exactly as before;
- search debug adds a tag-expanded counter, and the graph shows the tag-derived edges.

**Files:** `src/services/chat/memoryBank.ts`, `src/services/settings.ts`, `src/services/chat/savedMemory.ts`, `src/components/settings/MemorySettings.tsx`, `src/i18n/{zh,en}.ts`.

### 3.43 Upstream import performance and an in-app docs page (2.7.13)

**Following upstream.** Merged [5aaa34b](https://github.com/deepseek-ai/chat-demo/commit/5aaa34be44e3b42b8c34420f28de3294e754da6a) / [c9e1f33](https://github.com/deepseek-ai/chat-demo/commit/c9e1f33da981f8a236a2b899ebd374689cfa108d) (`perf: streamline history archive imports`) on top of this fork's existing import progress bar:

- `zipReader.ts`: a 512 KiB read-window cache (`WeakMap<File, …>`) and a cached central directory; `readBytes` serves small reads from the window and only tops up the tail when crossing it; the data-descriptor check moved into `checkDataDescriptor()` and runs after the entry body is read; `readEntry()` accepts a `detectType` callback so image types are detected while streaming instead of reading the whole Blob and slicing it.
- `db.ts`: `addStagingSession` became batched `addStagingSessions`; `updateStagingFileTypes` takes the affected session ids, reads them by id and only writes back changed records instead of scanning the whole store; empty batches return early.
- `importArchive.ts`: sessions are flushed in batches of 32 / 2 MiB and images in batches of 16 / 4 MiB; `readJson` decodes UTF-8 incrementally from the entry stream; `fileSessions` (attachment id → referencing sessions) means MIME backfill only touches sessions that reference recognised images; the progress callback (entries processed / total, chats imported) is unchanged.
- Measured: a 3000-chat, 3002-entry archive imports in about a second and the progress bar runs 0% → 100%; a 400-chat archive also passes; random bytes and truncated ZIPs are still rejected with `BackupError`.

**The Docs page.** A new sidebar entry above NanoVM Slim (book icon) that fills the chat area like the lab:

- Two language versions in `src/components/docs/docsContent.ts`, 24 sections: overview, settings map, chats and branches, roles and profile, workspace, voice, chat modes, composer and thinking depth, models and sampling, keyword refusal, jailbreak, web search and poisoning, attachments and large text, long-term and graph memory, virtual machines, local models, agent tools and the lab, stats and billing, data management, privacy, web / mobile / APK differences, known limits, FAQ and a glossary.
- A fixed table of contents on the left (collapsible on narrow screens) that highlights the current section while scrolling, and a `#` anchor next to every heading.
- Mobile / APK: the TOC becomes a full-width 44 px toggle (expands to 46vh), the article is single-column, tables keep their column widths and scroll sideways, `#` anchors are hidden on touch devices, and an “↑ Contents” button appears after the first screen; `env(safe-area-inset-bottom)` keeps it clear of the gesture bar. Measured at 390 px with no horizontal overflow.
- Inline links support `[text](#section)` and `[text](https://…)`: in-page links scroll smoothly, external links open in a new tab, all in the brand blue (`--dsw-alias-brand-text`) for a wiki-like feel.
- Four block types (paragraph, list, table, note); tables cover jailbreak switches, mode capabilities, memory parameters, VM comparison and the glossary.

**Files:** `src/services/chat/history/{zipReader,importArchive}.ts`, `src/services/chat/db.ts`, `src/components/docs/`, `src/services/docs/docsStore.ts`, `src/components/sider/Sider.tsx`, `src/app/App.tsx`, `src/components/base/icons.tsx`, i18n.

### 3.44 Memory missing on the first message of a new chat (2.7.14)

**Problem.** In a brand-new chat the first message never reached memory: `Last injected` could show a hit, yet the model knew nothing from the memory graph and even went looking through the workspace.

**Cause.** The first reply of a new chat also asks the server for a title: `streamReply` adds the turn's controller to `titleRequests` when `serverTitle && !session.title`. When assembling system, the code did:

```ts
const memoryContext = titleRequests.has(controller)
  ? ''
  : [savedMemoryEnabled ? formatSavedMemories() : '', memoryBankEnabled ? formatMemoryBankContext(...) : '']
      .filter(Boolean)
      .join('\n\n')
```

The intent was "a title request does not need memory", but the title and the real answer share one request, so the whole first turn skipped both saved memories and graph retrieval. From the second message on, a title exists and memory worked again — hence "the first message never has memory".

**Fix.** Removed the `titleRequests` gate so memory is retrieved and injected every turn:

- the first turn now calls `formatSavedMemories()` and `formatMemoryBankContext()` and puts the result into system;
- `useMemorySearchStats` updates on the first turn too, so `Last injected` matches what was really sent;
- the injected block now says these are facts the user confirmed and must be used directly, instead of "cite naturally when useful", which reduces "I do not know" replies despite memory being present.

**Verification.** Reproduced with a real key:

| Case | Before | After |
| --- | --- | --- |
| `system` of a new chat's first request | persona and mode note only | includes "Here are relevant memories retrieved from the user’s memory graph…" and the matched node |
| First question "Какой мой любимый цвет?" (node: бирюзовый) | said it did not know | answered "бирюзовый (teal)" |
| Hit statistics | not updated on the first turn | updated on the first turn |

**Files:** `src/services/chat/store.ts`, `src/i18n/{zh,en}.ts`, `src/components/docs/docsContent.ts`.

### 3.45 Documenting the parameters and the token economy (2.7.14)

**Why.** The docs only had a default-values table under "Models and sampling"; they never explained what temperature or top_p actually do, nor how tokens, cache and compression affect cost.

**Two new sections (bilingual; docs grows from 24 to 26 sections).**

- **Decoding and sampling**: starts from "the model scores every token and the sampler picks one", then explains:
  - temperature: divide by T before softmax, T<1 sharper / T>1 flatter, 0 close to greedy, thinking mode pinned to 1 by the server, plus suggested ranges and reasons for facts / chat / creative / above 1.5;
  - top_p: cumulative-probability nucleus, how it differs from temperature (reshaping vs cutting the tail), adjusting only one, what to tweak first when repetition appears, 0.85–0.95 for strict formats;
  - max_tokens: includes thinking tokens, empty means server default, range 1–65536, stop_reason=max_tokens when it is reached;
  - thinking depth: 0–4 mapped to reasoning_effort low/medium/high/max and budget_tokens 1024/4096/12000/32000, plus the automatic fallback when the server rejects them;
  - frequency / presence / repetition penalties: AutoTune computes them, but the Anthropic-compatible endpoint does not accept them, so only temperature and top_p are sent;
  - streaming and a preset cheat sheet (code / chat / creative / JSON / unsure).
- **Tokens, context, cache and compression**: token estimation (about one token per Chinese character, one per four English characters, digits and code split finer), the 1M window and the 32768 extension-field limit, prefix cache and hit prices (Flash 0.02/1, Pro 0.15/4.5), auto compression at 80% with 64k headroom, peak / off-peak billing and estimate caveats.

**Implementation.** The renderer gained an `h3` block (`DocsView.tsx` and a `.subheading` style) so parameters can be expanded individually; the glossary grew from 15 to 28 entries (logits, greedy decoding, nucleus sampling, stop_reason, SSE, prefix cache, context window, input/output tokens, hash vector, cosine similarity, relevance threshold, retrieval weights and more); the models table links to the new decoding section.

**Verified.** TOC grows from 24 to 26 items; no horizontal overflow on desktop or a 390px viewport; the temperature / top_p subheadings, preset table and glossary render correctly; `pnpm type`, `pnpm lint` and `pnpm build` pass.

### 3.46 Merging upstream chat-demo 0.1.4 (2.7.15)

Upstream 0.1.4 (`cdf9617`) contains four changes since 0.1.3: `5aaa34b` / `c9e1f33` (import performance, already merged in 2.7.13), `ea0d208` (import progress), `5477ea6` (attachments imported with their chats), `6da0786` (older-browser support) and `cdf9617` (release). This merge ports the latter two and switches our progress bar to upstream's per-chat accounting.

**1. Attachments imported with their chats (`5477ea6`).** The old implementation required images to appear after `chat_session_index.json`: it read every session first and all images afterwards. The new one enumerates the archive into `filesBySession` (`chat_sessions/<id>_files/` belongs to that session) and reads a session's files as soon as its JSON is processed:

- `readArchive` no longer requires consuming the current entry before advancing; each `stream` locates and verifies its entry when iterated. `ArchiveEntry` gains `offset`, used to deduplicate the same image across sessions (the physically earliest copy wins).
- The read cache goes from one window to two: session JSON and its attachments usually sit in different regions, so each gets a window to avoid repeated `slice` calls.
- Trailing attachment entries are only checked for ownership, not re-read; `flushSessions` flushes images first so attachments land together with their chat.

**2. Import progress by chat (`ea0d208`).** The UI stays the 2.7.10 progress bar, but the data now comes from upstream's shape:

```ts
export type ImportProgress = { done: number; total: number }
onProgress?.({ done: 0, total: totalSessions })
```

- The total is known after the first enumeration pass; until then the UI shows "Checking the file…".
- Each session batch reports `processed x / y chats`, never exceeding the total.
- A final `y / y` callback drives the bar to 100%.

**3. Older-browser support (`6da0786`).**

- New `src/utils/abort.ts`: `getAbortReason()` falls back to `DOMException(AbortError)` when `AbortSignal.reason` is missing and `throwIfAborted()` checks `aborted` itself; `attachments.ts`, `store.ts` and `resizeUploadImage.ts` use them.
- `toSorted` / `toReversed` replaced with `[...arr].sort()` / `[...arr].reverse()` (`toLocal.ts`, `NanoVMConsole.tsx`, `store.ts`).
- `100dvh` falls back to `100vh` under `@supports not (height: 100dvh)` (`App.module.css`, `ChatInput.module.css`), and the delete confirmation in `Settings.module.css` gets a two-line `max-height` fallback.

**Verification.**

| Case | Result |
| --- | --- |
| 400-chat archive | passes, "processed 400 / 400 chats" |
| 3000-chat archive | passes, 1504 / 3000 → 3000 / 3000 |
| Archive with one PNG placed after the index | passes; the chat imports and `files` holds a 70-byte `image/png` with MIME backfilled |
| Random bytes / truncated ZIP | still rejected (`BackupError`) |
| Legacy-engine build | `toSorted` / `AbortSignal.reason` no longer in the bundle; build passes |

**Files:** `src/services/chat/history/{zipReader,importArchive}.ts`, `src/services/chat/backup.ts`, `src/components/settings/SettingsDialog.tsx`, `src/i18n/{zh,en}.ts`, `src/utils/{abort,resizeUploadImage}.ts`, `src/services/{attachments,chat/store}.ts`, `src/services/chat/history/toLocal.ts`, `src/components/nanovm/NanoVMConsole.tsx`, `src/app/App.module.css`, `src/components/chatInput/ChatInput.module.css`, `src/components/settings/Settings.module.css`.


**4. The GenUI tool (added in the same version).** Settings → Browser tools gains "GenUI" (`show_genui`):

- The model sends a JSON spec `{"title":"…","blocks":[…]}` with text / heading / divider / stat / progress / table / chart / list / keyValue / callout / card / grid blocks;
- The client renders it with whitelisted React components: tables sort by clicking a header, line and bar charts use inline SVG, no arbitrary HTML and no iframe;
- Syntax and the project icon are ported from [dsh-genui](https://github.com/omdsh-dev/dsh-genui) (MIT); the icon appears on the tool row and the card title, and the credit is appended to the in-app changelog credits (after unkernel / go-deepseek) and 11-license;
- The parser in `src/services/agent/genui.ts` limits text length, nesting, rows and series; bad blocks are dropped individually and unknown types ignored. Unit tests cover a valid spec, empty blocks, malformed JSON and unknown blocks;
- Verified end to end: the model actually called `show_genui`, the stored `toolCalls[0]` finished with an artifact of kind `genui`, the reply rendered "本月概览 / ¥128,430 / table / bar chart", and the settings row shows the GenUI icon.

### 3.47 Custom prompt-injection tool (2.7.16)

Settings → Browser tools gains a custom prompt-injection tool: the answer body becomes the argument of a client tool call, and the client restores it as plain text once the reply arrives. The tool performs nothing; it only changes the channel the model's answer travels through.

**1. Configuration (`src/services/agent/customInjection.ts`).** You fill in the tool name, description, argument name and argument description; the description must state that the answer body goes into that argument:

```ts
type CustomInjectionConfig = {
  name: string            // tool name sent to the API, e.g. emit_answer
  description: string     // what the model reads
  paramName: string       // argument carrying the body, content by default
  paramDescription: string
  forceToolChoice: boolean
  assistantRule: 'off' | 'generated' | 'all'
  userRule: 'off' | 'paired' | 'marked'
  marker: string          // prefix marker for userRule=marked
}
```

- `sanitizeToolName` / `normalizeCustomInjection`: invalid characters become underscores, a leading digit gets a `tool_` prefix, the argument cannot equal the tool name, and unknown rule values fall back to defaults. An empty name may be stored (the user is retyping) but `customInjectionReady` is false, so the tool is not sent.
- `customInjectionDefinition` builds the `ClientToolDefinition` with `required: [paramName]` and `additionalProperties: false`; an empty description falls back to the default text.

**2. Request assembly (`requestPlan` in `store.ts`).** The name, description and argument all come from the config, so the static `custom_injection` registry entry only exists for the settings row: it is skipped and the generated definition is sent instead. Forced mode adds `tool_choice: { type: 'tool', name }`.

Three fields were found to conflict with `tool_choice` — the server answers `Thinking mode does not support this tool_choice`:

| Field | Handling |
| --- | --- |
| Thinking (`thinking.enabled`) | Switched to `{ type: 'disabled' }` for the round, with one toast per session |
| `safety_check` | Omitted for the round |
| Server tools (`deepseek_read_url` / `deepseek_web_search`) | Not sent for the round |
| `title: { enabled: true }` | Not requested; the title falls back to the first 24 characters of the question |

**3. Body restore (`applyCustomBody` in `reply.ts`).** After the stream ends, if a tool slot holds an injection call, its argument is extracted (`extractCustomBody` prefers the configured argument name and falls back to the first string when the model used another key) and appended to the answer: it is concatenated into a trailing text block or added as a new one, and the reply records `customTool: { name, param }`. The turn no longer executes a tool, no `tool_result` round follows, `stopReason` drops back from `tool_use` to `end_turn` and `prefix` returns to true — so copy, edit, stats and everything else treat it as a normal answer.

**4. History restore (`toRequestMessages`).** Multi-turn context must keep the same shape, otherwise the model starts mixing prose with a trailing tool call:

- Rules: `convertAssistant` (only generated / all) picks which assistant messages become `tool_use`; `convertUser` (paired / marked) decides whether the following question becomes its `tool_result`.
- Protocol: `tool_use` must be followed by a paired `tool_result`, so reminders for such rounds move from after the question to before it; a question with attachments puts `tool_result` ahead of the file blocks; an assistant reply is only converted if the next question really enters the request (`userHasBody`).
- Conversion runs only when the tool is actually sent this round: a disabled tool or stripped extension fields leave history as text, so the request never carries an undeclared tool.
- It executes nothing and is only an output channel, so `modeAllowsTool` exempts it: chat-only mode still sends this one tool (every other browser tool stays off).
- The `tool_use` id derives from the reply id (`toolu_<id>`) and stays stable across requests on the same branch.

**5. Settings UI (`CustomToolSetting.tsx`).** A collapsible card: the header shows the tool name, argument name, forced/history chips and the switch; expanding reveals the tool definition form, the force switch, two rule selects plus the marker input, and a preview that prints both the API tool definition JSON and the converted history shape. An invalid name raises a warning chip with the reason. Inside the fixed-height settings scroller the card needs `flex-shrink: 0`, otherwise it collapses to a 2px line (observed in the first build).

**Verified.**

| Case | Result |
| --- | --- |
| Unit: name sanitising / rule fallback / argument equals tool name / definition and tool_choice shape / body extraction | pass |
| Unit: history restore (generated vs all vs off, paired vs marked, reminder position, attachment order, prefix continuation, no plan) | pass |
| Live API: forced tool_choice makes the model write the body into `content` | pass |
| In-app E2E (Chromium + live API): first request carries tool_choice and no server tool / safety_check / title; the reply renders as text with no tool card; the stored reply has `customTool`, no `toolCalls` and `stopReason=end_turn` | pass |
| In-app E2E: the second request sends the previous answer as `assistant: tool_use` and the current question as `user: tool_result` with a matching id | pass |
| Settings: tool row, config card, preview, name persistence and invalid-character cleanup; 390px single-column layout without horizontal overflow | pass |

**Files:** `src/services/agent/{customInjection,tools,agentToolSettings}.ts`, `src/services/chat/{store,reply,types}.ts`, `src/services/api/types.ts`, `src/services/settings.ts`, `src/components/settings/{CustomToolSetting,AgentToolsSetting}.tsx`, `src/components/docs/docsContent.ts`, `src/i18n/{zh,en}.ts`.

### 3.48 latest_reminder injection fix and memory node filtering/editing (2.7.16 patch)

A patch inside the same version: it removes the 400 caused by "inject the system prompt every round" and adds what managing 100+ memory nodes actually needs.

**1. Per-turn injection no longer goes into latest_reminder.**

The old code concatenated the round reminder and the system prompt into one string and sent it as `latest_reminder`:

```ts
const requestReminder = injectPromptEveryTurn
  ? `${latestReminder}\n\n${baseSystemText}`
  : latestReminder
```

The server parses `latest_reminder` as exactly five comma-separated fields (`<date>,<weekday>,<location>,<platform>,<language>`), so commas in the prompt pushed the remaining text into the platform or language field. Three observed shapes:

| Input | Result |
| --- | --- |
| `2026-11-25,星期三,杭州,Web,中文\n\n你现在是一位助手，请使用简体中文、简单的语言和任何词汇回应。` | 400 `unknown language '中文\n\n你现在…'` |
| `2026-11-25,星期三,杭州,Web,中文你是助手,请简单回答` | 400 `unknown platform '中文你是助手'` |
| `2026-11-25,星期三,,Web,中文` | 200 (an empty location is fine, so blank fields are not the issue) |

Now `latestReminder` stays a clean five-part string and the injected system prompt is appended to the end of system (`[systemText, foldedReminder, repeatedSystem].join('\n\n')`); local models have no `latest_reminder` role, so it is folded into their system too. Fields are additionally flattened (`reminderField`) so a location like "Hangzhou, Zhejiang" cannot trigger the same error.

**2. Memory node filtering.**

`MemorySettings.tsx` gains a filter block above the node list:

- The search box filters by title / body / tags with `NFKC` + lowercase normalisation, so Cyrillic and other scripts match;
- Tag buttons are aggregated from node tags (normalised, sorted by frequency, with counts), multi-selectable, intersected with the keyword and toggled off by clicking again;
- A "showing x of y nodes" line tracks the count and an empty state appears when nothing matches;
- The graph gains `highlight`: while filtering, non-matching nodes fade to 0.22 so the overall shape stays readable.

**3. Inline memory node editing.**

Each node card gains an edit button that expands into title / body / tags fields backed by `nodeDraft`:

- Saving calls the existing `updateMemoryNode(id, { title, content, tags }, tagExpansion)`; a blank title falls back to the first 40 characters of the body and tags are split on commas or newlines, capped at 8;
- With "tag linking & graph expansion" on, `updateMemoryNode` drops the node's old tag edges before relinking from the new tags, so no dangling edges remain;
- An empty body disables Save with a toast, and Cancel writes nothing.

**Verified.**

| Case | Result |
| --- | --- |
| Unit: `createLatestReminder` five parts, location with half/full-width commas and newlines flattened, empty location still five parts | pass |
| Live API (pre-fix reproduction): prompt concatenated into latest_reminder → 400 unknown platform / unknown language | reproduced |
| In-app E2E (live API, system prompt with commas and newlines + per-turn injection): `latest_reminder` is exactly five parts with no newline and a valid language; the prompt appears twice in system and ends the block; the reply is done and the stored reminder snapshot is clean | pass |
| In-app E2E (V4 Pro folded path): no `latest_reminder` role, the reminder folds into system, the prompt repeats twice and the reply works | pass |
| 40-node list: keyword (including Cyrillic), tag, tag+keyword filters, clear, counts and 37 dimmed graph nodes | pass |
| Inline edit: prefill, title/body/tag changes, persistence, other nodes untouched, `updatedAt` bumped, empty body blocks save, cancel writes nothing, edited body is searchable | pass |
| Tag edge maintenance: adding a shared tag creates a `tag` edge, removing it deletes the edge | pass |
| 390px viewport: filter bar, tag buttons and edit card without horizontal overflow | pass |

**Files:** `src/services/chat/latestReminder.ts`, `src/services/chat/store.ts`, `src/components/settings/{MemorySettings.tsx,MemorySettings.module.css}`, `src/components/docs/docsContent.ts`, `src/i18n/{zh,en}.ts`, `src/components/settings/SettingsDialog.tsx`.

### 3.49 latest_reminder ordering fix (2.7.17)

Fixes a regression introduced in 2.7.16: requests carrying history were rejected with

```
messages.23: a `latest_reminder` message must be immediately followed by a `user` message
```

**Root cause.** 2.7.16 rewrote the round loop in `toRequestMessages` to restore history as tool calls for the custom prompt-injection tool. To keep `tool_use` and `tool_result` adjacent, the reminder insertion was split into two paths:

```ts
const reminderFirst = pendingToolUseId !== null || toolUse !== null
if (reminderFirst) appendReminder(reply.latestReminder)
messages.push(toUserParam(user))
if (toolUse) { ... } else {
  if (!reminderFirst) appendReminder(reply.latestReminder)   // ← inserted after the question
  messages.push(toAssistantParam(reply))
}
```

Plain rounds (`reminderFirst === false`) therefore produced `user → latest_reminder → assistant`, while the server requires a `user` message immediately after `latest_reminder`. A first turn has no history, so 2.7.16's acceptance run did not catch it; from the second turn on, any historical reminder snapshot that differs from the previous one triggers it, which is what surfaced as `messages.N` in longer chats.

**Fix.** Reminders are always inserted before the question — the `reminderFirst` branch is gone — and two further server constraints were verified against the live API and handled:

| Shape | Server |
| --- | --- |
| `user → latest_reminder → assistant` | 400 `a latest_reminder message must be immediately followed by a user message` |
| `latest_reminder → latest_reminder → user` | 400 (`latest_reminder must have at least …`) |
| `latest_reminder → user → assistant` | 200 |
| `assistant(tool_use) → latest_reminder → user(tool_result)` | 400 `tool_use ids were found without tool_result blocks immediately after` |
| `latest_reminder → user → assistant(tool_use) → user(tool_result)` | 200 |

That led to two more changes:

1. **Compression summary and round reminder are merged.** The summary itself is sent as `latest_reminder`; a following round with a changed reminder would create two reminders in a row. `appendReminder` now detects a preceding reminder and appends the new text to it (`summary\n\nreminder`) instead of pushing a second message.
2. **History restoration for the injection tool yields to reminders.** If the question after a restored `tool_use` needs a new reminder (day change, different location), the reminder would sit between `tool_use` and `tool_result` and be rejected. `toRequestMessages` rehearses the reminder positions first (`reminderFlags`) and drops that round's restoration when it collides; history goes back to plain text there, while rounds with unchanged reminders are still restored.

**Verified.**

| Case | Result |
| --- | --- |
| Unit: 2 / 3 rounds, duplicate reminders, compression summary, compression with rounds left, continuation prefix, skipped empty question, no reminders | all satisfy “reminder followed by user, no adjacent reminders, tool_use followed by tool_result” |
| Unit: compression summary plus the first round reminder merge into one message containing both, zero adjacent reminders | pass |
| Unit: injection-tool restoration — unchanged reminders still restore, a changed reminder drops that round's restoration | pass |
| Live API, three-turn chat (deepseek-flash): all three requests 200, role sequence `latest_reminder,user,assistant,user,assistant,user`, all replies `done` | pass |
| Live API with the injection tool: second turn is `latest_reminder,user,assistant(tool_use),user(tool_result)`; after changing the location the next turn puts the new reminder before the question, the previous round is not restored, and the request is still 200 | pass |

**Files:** `src/services/chat/reply.ts`, `src/i18n/{zh,en}.ts`, `src/components/settings/SettingsDialog.tsx`.

### 3.50 Merging the new Unkernel Linux page (2.7.17)

Upstream `pithings/unkernel` released `v0.2.0-261126-fd204d3` on 2026-11-26 and rewrote the page from a console-with-demos into a desktop. This round merges it in full while keeping our two additions — the **DSH go launcher** and the **host's Unkernel settings panel** — and localizes the whole page again.

**1. The new page.** It is a desktop now:

- a window manager (dock, window menu, fullscreen / minimize / maximize), a control center, a preview browser (guest ports) and Wayland windows (wland);
- an app launcher with 80+ apps in 11 groups: AI (Claude Code, Ollama, llama.cpp, fx), tools (Git, Zed, Neovim, tmux, htop), runtimes (Node, Python, Go, Rust, Bun), servers (nginx, PostgreSQL, Valkey, SQLite), Linux (Ubuntu chroot, Docker, box64), browsers (Chromium, Firefox, Ladybird), desktop (Xfce, X11, XPaint…), games (Steam, Doom, Minecraft, SuperTuxKart…), media (VLC, mpv, radio), graphics (kmscube, Vulkan, Wayland GL) and system;
- each app downloads its files into the guest on first run and installs its packages with `apk` / `apt`, with progress in an installer window;
- guest GL (virgl/WebGL2), Vulkan (WebGPU), VA-API (WebCodecs), the 9p workspace, the data disk, snapshots and suspend are all still there.

**2. Host integration.**

- `public/unkernel/` is regenerated with `KW_BASE=/unkernel/` and then `scripts/patch-unkernel-page.mjs` prefixes the distro images, service worker, preview paths and manifest (the new script matches backtick template literals and also handles CSS fonts and `new URL('/assets/…')`).
- `unkernelUrl()` uses the new parameters: `distro`, `mem`, `datasize` (GiB, converted from the host's disk MiB), `net`, `sound`, `display`, `data`, `worker`, `cpus`, `wisp`; the old `disk` parameter is gone.
- The host's `KW.vm.exec` / `mount` / `write` / `resize` / `stop` still match the new `KernelHandle`, so `waitForUnkernelVm`, the workspace mount and the ten agent tools need no API change; the workspace is still at `/mnt/workspace` (verified: `mounts` contains it).
- The `dropLegacyScope` guard is kept: the page only unregisters a root-scope service worker whose script ends in `/vm-sw.js`, never the host's `coi-sw.js` (otherwise a multi-CPU iframe would fail without COEP).
- The page's own settings (storage, session, display…) still work, but the host overrides them with URL parameters on every restart, so the host panel stays authoritative.

**3. DSH go.** It moved from the old demos into a standard app (`web/src/apps/agents/dsh-go.ts`, title “DSH go”, whale icon, `~/demos/dsh-go`): the first run downloads the 24,576,162-byte static binary from the page's origin (SHA-256 pinned), pushes it into the guest and executes it. `web/src/download.ts` now resolves relative URLs so page-served assets can be an app's `downloads`.

**4. Localization.** Three parallel passes translated the page: `web/src/components/**` (~500 UI strings), `web/src/apps/**` (73 descriptions plus 11 group metadata, product names kept) and `web/src/*.ts` with `index.html` (~815 boot-log, status, error and hint strings). Technical output, scripts, commands and kernel logs stay English.

**Verified.**

| Case | Result |
| --- | --- |
| Page boots under the `/unkernel/` prefix (Chromium, JSPI) | pass: `KW.vm` ready, `uname -a` returns `Linux 7.3.4+ … aarch64` |
| Page language and title | `lang=zh-CN`, title “unkernel — 浏览器里的 Linux”, Chinese boot log and buttons |
| App launcher | 11 groups with Chinese names; the AI folder contains DSH go |
| DSH go end to end | pass: installer adds `ca-certificates bash`, downloads and pushes the 24,576,162-byte binary, and the terminal runs `dsh-go` (about 14 s) |
| Host iframe | pass: `/unkernel/index.html?distro=alpine&mem=512&datasize=8…`, `KW.vm` ready, `vm.exec` works, page in Chinese |
| Host settings panel | pass: memory / data disk / distro / devices / files / restart present; disk set to 16 GiB and restarted, the iframe URL becomes `datasize=16` |
| Workspace | pass: the guest's `mounts` contains `/mnt/workspace` and `ls` works |
| Agent tool (live API) | pass: the model called `unkernel_shell`, which ran `uname -a`, finished `done` and returned the kernel version |
| 390px viewport | pass: no horizontal overflow, dock and launcher usable |
| WebSocket / Wisp networking | outbound `wss://` from the local browser is blocked by this network (three different servers time out); the page's network layer is unchanged and the host wisp parameters are as before |

**Files:** `public/unkernel/` (whole page replaced), `scripts/patch-unkernel-page.mjs`, `src/services/unkernel/config.ts`, `src/i18n/{zh,en}.ts`, `src/components/settings/SettingsDialog.tsx`, `src/components/docs/docsContent.ts`; on the page source: `web/src/apps/agents/{dsh-go.ts,index.ts}`, `web/src/download.ts`, `web/src/sw.ts`, `web/vite.config.ts`, `web/public/demos/dsh-go/`, plus the localized `web/src/**` and `web/index.html`.
