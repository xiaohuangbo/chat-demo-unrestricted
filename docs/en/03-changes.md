## 3. What this fork changes

### 3.1 Settings layout

The settings dialog grows from two groups to sixteen:

| Group                 | Contents                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General               | Theme, language, TTS voice, location, daily usage and alerts                                                                                                                                   |
| **Model**             | Current model, stream output, temperature, Top P, max output tokens, anti-retraction, auto-compress, skip safety check, continue refused replies, keyword refusal                              |
| **Prompt**            | Unrestricted mode, per-round prompt injection, custom system prompt, pipeline explanation, full preview                                                                                        |
| **Chain of thought**  | Settings + composer card: switch, step editor, example / clear, injection preview; injected steps appear above replies when deep thinking is off                                               |
| **Advanced**          | System prompt preset, Chinese jailbreak prompts, input perturbation, auto jailbreak, AutoTune, output shaping                                                                                  |
| **Search poison**     | Custom current time and knowledge cutoff, search takeover, keyword / regex replacement, blacklist, forced results and whitelist                                                                |
| **Memory**            | Long-term memory, auto-extraction, memory graph, import/export, relation graph, vector dimension, retrieval weights, search debug                                                              |
| **Attachments**       | Limit switch, max size per file, max files per session, extension whitelist                                                                                                                    |
| **Attachment poison** | Rewrite attachments before upload: text body / image text / DOCX / metadata / file trailer / filename / companion text attachment                                                              |
| **Browser tools**     | Master switch plus ten independent capability switches: date & time, location, weather, notifications, clipboard read / write, webpage fetch, file generation, open link, visualization widget |
| **Workspace**         | Virtual file store in browser storage: create / edit / delete files, per-file download, whole-archive import (merge or replace) and export                                                     |
| **Virtual machines**  | Two terminals: NanoVM Slim (WASM shell, quotas, toolchains, virtual network) and WebVM (CheerpX x86 Debian, cross-origin isolation, images, import/export, environment check); both run at once and switch freely |
| **Statistics**        | Usage overview with range switch, daily trend bars, 8-week activity heatmap, input composition ring, per-model split, context statistics management                                            |
| Data                  | API key, import, export, restore default settings, delete all                                                                                                                                  |
| About                 | Repository, demo and upstream links                                                                                                                                                            |
| Changelog             | Version history and upstream credits                                                                                                                                                           |

No existing style rules were modified. New controls only use newly added classes (the switch, slider, and editor each ship their own CSS Module; a few prompt-preview classes are appended to the settings stylesheet), and colours and radii come from the existing design tokens.

### 3.2 Unrestricted mode

**Where:** Settings → Prompt.

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
| Inject the system prompt every round     | Settings → Prompt                               | Silently appends the current system prompt to `latest_reminder` on every request so long chats keep the setup; it is not stored in history snapshots, and input tokens clearly increase.                                                                                                                                                                                                                                     |
| Chinese jailbreak prompts (experimental) | Settings → Advanced                             | Replaces the built-in GODMODE and depth directive with Chinese translations. Phrasing and training-data differences may weaken the jailbreak, so it is off by default. L1B3RT4S combos stay in English.                                                                                                                                                                                                                      |
| Disguise historical thinking             | Settings → Prompt                               | Folds the **previous** reply’s thinking into the historical assistant text so the server does not drop it; only the last historical round is converted and token usage rises slightly.                                                                                                                                                                                                                                       |
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

Settings → Attachment poisoning. Off by default; when enabled, attachments are rewritten locally before upload so the model sees your text when it reads them.

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
- **Auxiliary usage**: web searches, parsed document pages, TTS characters and ASR seconds — the parts of the bill that token counts do not cover.
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

[← 返回 README](../../README.md) · [全部文档](README.md)
