# FORK NOTES — 9Router (local / dev branch)

This document tracks changes carried on this fork's development branch (`dev`, formerly `local`),
which is ahead of upstream `master` (`decolua/9router`). It is intentionally kept separate from
the upstream `README.md` to avoid merge conflicts when syncing from upstream.

## Branch

- `dev` (was `local`) — this fork's development line, tracks the 0.5.x feature work.
- Rebased/synced against upstream `master` via `scripts/upstream-sync` (see commit `d8cad106`).

## Changes vs upstream `master`

44 commits unique to `dev` as of 2026-10-26 (range 2026-07-10 → 2026-10-26), grouped by area.
Hashes are the **current** `dev` hashes — an earlier rebase invalidated the ones previously
listed here, so treat this list as the source of truth.

### 🖥️ Desktop app (Tauri 2)
- `feat(desktop): add tauri desktop app support and accompanying tweaks` (`0b73c375`)
- Added `src-tauri/` (Rust shell, icons, `tauri.conf.json`, `Cargo.toml`, `main.rs`).
- npm scripts: `tauri:dev`, `tauri:build` (see `package.json`).
- `feat(tray): add lightweight mode toggle and supporting app handling` (`60cd419b`)
- `refactor: fix pxpipe and improve tray menu` (`6b83ff38`)
- `chore: ignore Rust/Tauri build artifacts` (`2cfaa653`)
- `chore(tauri): bump desktop shell to v0.5.109` (`edf078cb`)
- Shared UI additions to support the desktop shell: `TrafficLights.js`, `CloseConfirmModal.js`,
  tray/lightweight-mode handling in `DashboardLayout.js`, and a self-hosted `open` launcher tweak.

### 🔌 Volcengine / Ark integration
- `feat: add support for volcengine agent plan provider` (`94958776`) — `ark-ap-provider.js`
- `feat: add volcengine sso provider support` (`a5ffe519`) — `src/lib/oauth/providers/volcengine-sso.js`, `src/lib/volcengine/ssoLogin.js`
- `feat(volcengine-ark): add long-lived IAM AK/SK and OpenAPI usage/billing` (`d54dd31e`)
- Claude-format transports on both Ark providers (`/api/coding/v1/messages` and
  `/api/plan/v1/messages`) — folded into the provider-config refactors below (`976f644e`, `ee6b17aa`).
- `feat(ark-ap-provider): add doubao-seed-evolving model` (`fba672a1`)
- `feat: add ark responses and thinking support` (`e594b9ee`) — `responsesTransformer.js` wiring,
  Ark thinking levels in `thinkingLevels.js` / `thinkingUnified.js`, richer `requestLogger.js`
  capture, `requestDetailsRepo` trimming.
- New API routes: `src/app/api/usage/ark-billing/route.js`, `src/app/api/usage/ark-plans/route.js`
- Dashboard panel: `components/ProviderLimits/ArkOpenApiPanel.js`
- `open-sse` backend additions: `volcengine-ark.js`, `volcengine-ark-openapi.js`, `signerV4.js`
  (V4 request signing for Volcengine), plus reasoning/streaming utilities.

### 📊 Usage analytics (sessions, trace, per-model stats)
A fork-only usage stack on top of upstream's flat request log.

- `feat: add session usage stats and dashboard trace tab` (`8738b5a3`) — new **Trace** tab
  (`dashboard/usage/components/TraceTab.js`), `/api/usage/sessions` +
  `/api/usage/session-requests` routes, session columns in `src/lib/db/schema.js`, and
  `getSessionStats` in `usageRepo.js`. Session ids are threaded through every chatCore handler
  so non-streaming, streaming and forced-SSE-to-JSON paths all attribute usage.
- `feat: add connection-based usage stats grouping` (`8c19844f`) — group sessions by
  `connectionId` so per-account cost is visible.
- `refactor: simplify usage stats, add new models and unclassified support` (`9c7148c1`) —
  `unclassified` bucket for requests with no session id, lighter aggregation pass.
- `feat: add per-model stats, filtering, and pagination` (`4a6e9f00`) — per-session per-model
  breakdown (lazy-loaded by the session drawer via `includeModelStats=false` on the list),
  date-range filtering and pagination in TraceTab.
- `fix: add usage tracking and refine provider configs` (`4d3e105e`) — cache-token accounting
  (`cached_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`).

### 🔧 Claude translator compatibility
- `feat(claude-translator): add tool_reference downgrade for non-Anthropic Claude backends`
  (`3c1290f9`, merged with `25dbe930`) — tool-search clients (Claude Code / ZCode) return
  `tool_reference` blocks in `tool_result` content; Anthropic parses them, every other engine on
  a Claude-format transport rejects the block outright (AMR Link / open-design answer HTTP 422
  `messages[N]: missing field content`, Kimi's gateway fails the same way). Non-Anthropic targets
  get `[tool loaded: <name>]` text instead; the referenced tools already ride in `tools`.
  Adds `TOOL_REFERENCE` to the Claude block schema and
  `tests/unit/claude-tool-reference-downgrade.test.js`.
- `refactor: clean up thinking config and fix applyFormat args` (`32d4972a`) —
  `thinkingLevels.js` / `thinkingUnified.js` tidy-up.

### 🔐 Provider additions (OAuth / device login)
- `feat(providers): add Zai GLM Start Plan (zcode-plan channel on zcode.z.ai)` (`8a02a4fe`) —
  same CLI-polling OAuth as `glm` but keeps the zcode JWT instead of minting a coding-plan API
  key (`mintPlanApiKey: false`), because Start Plan entitlement and billing live behind
  `zcode.z.ai`. Traffic is Anthropic-messages on
  `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`. New
  `executors/glm-start.js` + `glm-start-identity.js`, `services/usage/glm-start.js`,
  `providers/registry/glm-start.js`, OAuth provider, connection test and dashboard wiring.
- `feat(providers): add Open Design with device login and quota usage` (`0a78d51a`) — AMR Link
  subscription gateway (`open-design.ai`, alias `od`). One API key reaches every entitled model
  on all three surfaces (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`); dual auth
  (device login primary, `sk-amr-…` key also accepted). Quota (credits windows + wallet balance)
  comes from the console session cookie — `getOpenDesignUsage()` in `services/usage/misc.js`;
  non-entitled plan models answer `403 tier_model_not_entitled`.

### 🧠 Thinking wire selection (multi-endpoint providers)
- `open-sse/providers/registry/open-design.js` — the Claude transport now declares
  `thinkingFormat: "claude-budget"`. `/v1/messages` is a native Anthropic surface and must
  receive `thinking: { type: "enabled", budget_tokens: N }`. Before this, neither the
  `transports[]` entries nor the single `transport` block declared a thinking format, so
  `resolveFormat` fell through to the model capability — `deepseek-v4.1-flash` resolved to
  `thinkingFormat: "deepseek"` — and sent `thinking:{type:"enabled"}` plus
  `reasoning_effort:"max"` to the Anthropic wire. `deepseek-v4.1-flash` then intermittently
  ended an agent turn with a one-sentence status and `stop_reason:"end_turn"` instead of its
  tool call. Replaying the exact request body: 2 of 11 baseline runs ended prematurely, versus
  0 of 9 with the Anthropic thinking shape (and 5 of 5 with `thinking:{type:"enabled"}` and no
  `reasoning_effort`).
- Scope: `transports[].thinkingFormat` applies only when the outgoing wire matches that
  transport's `format`, and it outranks the single `transport.thinkingFormat`, the
  `capabilities.js` model entry, and the wire default (`FORMAT_TO_NATIVE`). Open Design's Chat
  and Responses transports keep the model's DeepSeek effort lane; only `/v1/messages` changes.
  The same mechanism is already used by Muse and OpenCode Go for their `/v1/responses` wire.
- Tests: `tests/unit/open-design-thinking-transport.test.js`.

### 🔁 Streaming / tool / reasoning improvements
- `feat: add streaming reliability, tool handling, and reasoning improvements` (`b3378a01`)
- `open-sse/utils/stream.js`, `reasoningCache.js`, `textualToolCall.js`, translator schema/tool-call coercions.
- `fix(stream): correct passthrough termination and Claude aggregation` (2026-10-26) —
  `createPassthroughStreamWithLogger` now receives `sourceFormat`, so
  `shouldEmitDoneTerminator` is false for Claude clients and they no longer get a non-standard
  `data: [DONE]` after `message_stop`. The same change dedupes an upstream `[DONE]` for OpenAI
  passthrough streams and aggregates `text_delta` / `thinking_delta` for request details instead
  of reporting `[Empty streaming response]`.
  Tests: `tests/unit/passthrough-done-terminator.test.js`.

### 🌐 Web Tools Adapter (server tool emulation)
Targets that cannot run the client's web tool natively keep working web search/fetch: the
gateway executes the tool through the configured providers and replays the results to the
model. Two client wires are supported:

- **Claude wire** — `POST /v1/messages`, `web_search_20250305` / `web_fetch_20250910`.
- **Responses wire** — `POST /v1/responses`, hosted `{ type: "web_search" }` (Codex).

Native support is a **per-wire** question, not a per-provider one:
  - **Claude wire**: native passthrough (`anthropic`, `anthropic-compatible-*`), or a provider
    whose top-level `transport.quirks.claudeSupportedToolTypes` whitelists **every** requested
    type (DeepSeek today) → `prepareClaudeRequest` forwards it; everything else emulates. A
    Claude-format wire alone is not native support: the model's `search` flag being true does
    not stop the tool from being deleted before dispatch. Both Ark endpoints deliberately carry
    **no** Claude whitelist: their native behaviour is model-dependent (see the probe).
  - **Responses wire**: on a same-format `/v1/responses` request the hosted tool is forwarded
    verbatim, so **native is the default**. A provider that declares the type in
    `transport.quirks.responsesUnsupportedToolTypes` is emulated up front: open-design
    (gateway 400) and the Ark coding plan (silently ignores the tool, no error). A cross-format
    hop always emulates, because hosted tools cannot survive translation.
  - Partial whitelist coverage emulates the whole set, since the uncovered tool would vanish.
  - **Entitlement / silent-denial fallback**: a provider can declare native support that the
    account is not entitled to. When the upstream answers a web-tool access error
    (400/401/403/404/422 mentioning web search/fetch), `chatCore` re-plans with
    `forceEmulate: true`, rebuilds the body and retries once — nobody has to delete provider
    code. With no adapter providers configured, the original error is returned. Only non-2xx
    responses are retried; an error inside an already-started 200 SSE stream cannot be replayed,
    and a 200 that silently ignores the tool needs the deny-list above.
  - **Live probe (2026-10-26), Claude wire** — which upstreams really execute the
    Anthropic server tools when a Claude client hits their `/v1/messages`:

    | endpoint | `web_search_20250305` | `web_fetch_20250910` |
    |---|---|---|
    | `anthropic` | native | native |
    | `ark-ap-provider` (Agent Plan, `/api/plan/v1/messages`) | **emulated by policy** — doubao ids execute `server_tool_use` natively, but `deepseek-v4.1-flash` answers 200 with client `tool_use` blocks; a provider-level whitelist cannot express that split | emulated |
    | `volcengine-ark` (coding plan, `/api/coding/v1/messages`) | **emulated by policy** — 403 when 豆包搜索 is inactive, 200 + client `tool_use` when the model/account does not execute server tools | emulated |
    | `open-design` (`/v1/messages`, all Claude ids) | HTTP 400 `unsupported Responses tool type "web_search" … on Chat route` (also with `anthropic-beta: web-search-2025-03-05`, and on `/v1/responses` with the hosted tool) | HTTP 400, same |

    Doc reference for the coding plan (Claude wire):
    `console.volcengine.com/ark/region:cn-beijing/docs/coding-plan-personal-ai-claude-code.md`
    §"使用 Claude Code 的 Web Search 功能" — "通过 Messages API 接入的 Claude Code 也可原生使用 Web Search 功能".

    The **Codex wire is a different mechanism**: the coding-plan doc says "通过 Responses API
    接入的 Codex 也可原生使用 Web Search 功能", i.e. the client's hosted
    `{ "type": "web_search" }` tool on `POST /api/coding/v3/responses`.
    `resolveTransport(provider, "openai-responses")` selects the matching transport and
    `sourceFormat === targetFormat` skips translation. Probed 2026-10-26:

    - `ark-ap-provider` `/api/plan/v3/responses`: **native** — `web_search_call` items in
      `output`, on the same agent-plan account.
    - `volcengine-ark` `/api/coding/v3/responses`: **silent ignore** — HTTP 200 without any
      `web_search_call` (the model answers "I can't search the live web"), so it declares
      `responsesUnsupportedToolTypes: ["web_search", "web_search_preview", "web_fetch"]`.
    - `open-design` `/v1/responses`: HTTP 400, same deny-list.

    The coding-plan doc also notes each native search triggers an extra model call to
    summarize the results. Doc:
    `console.volcengine.com/ark/region:cn-beijing/docs/coding-plan-personal-ai-codex.md`.

    Neither Ark provider declares `claudeSupportedToolTypes` on the **top-level `transport`**
    (that is what `providers/index.js` publishes; a quirk on a `transports[]` entry is
    invisible). Their Claude wire always emulates. `ark-ap-provider` keeps its Responses wire
    native; `volcengine-ark` declares the Responses deny-list above. DeepSeek is the only
    remaining Claude whitelist in this repo: its Anthropic endpoint rejects custom tools
    outright, so the list both preserves `web_search_*` and filters everything else.
- `open-sse/services/serverToolEmulator.js` — detection, history downgrade, tool injection,
  the emulation loop and the client-facing SSE synthesizer:
  - Emulated rounds run upstream **non-streaming** (the loop buffers complete rounds), then the
    client gets standard `server_tool_use` / `web_search_tool_result` / `web_fetch_tool_result`
    blocks restored in SSE or JSON shape.
  - Tool injection, round appends and response parsing are per target format: Claude
    `input_schema` tools, OpenAI `function` tools, or Responses flat `function` tools with
    `function_call_output` input items. Upstream SSE is aggregated for all three (Claude
    events, OpenAI chunks, Responses `response.completed`).
  - Client responses are synthesized in the source wire: Anthropic SSE/JSON for Claude
    clients, Responses events/JSON (`web_search_call` + `output_text`) for Codex.
  - Result blocks use Anthropic's strict typed shapes, not loose variants:
    `web_search_result` items carry `encrypted_content` (ZCode's Zod schema requires it),
    `web_fetch_tool_result.content` is a `web_fetch_result` document
    (`source: { type:"text", media_type:"text/plain", data }`), and failures use
    `web_search_tool_result_error` / `web_fetch_tool_result_error` with `error_code`.
  - Replayed history blocks are downgraded to a plain tool loop per turn: Claude
    `server_tool_use` / `*_tool_result` blocks, and Responses `web_search_call` items
    (turned into an assistant text item). `srvtoolu_` ids are rewritten to `toolu_` so strict
    Claude-compatible endpoints accept them.
  - `max_uses` is honored with a hard cap; a failing tool execution surfaces as an error
    tool_result instead of aborting the request (fail-open). Mixed rounds (emulated + real client
    tools) hand the turn back to the client.
  - Search snippets and fetched page text are injected inside explicit
    `<web_search_results>` / `<web_fetch_result>` untrusted-content boundaries, because page
    content is a prompt-injection channel.
  - Usage is split: the client receives Anthropic semantics (last round's prompt size as
    `input_tokens`, summed `output_tokens`), while `result.billed` carries the cumulative
    tokens the router actually paid across every round for usage tracking.
- `src/sse/services/webToolsBridge.js` — credential lookup (incl. `credentialFallback`, e.g.
  `ollama-search` → `ollama`), SSRF guard shared with `/v1/web/fetch`, and provider-pool
  fallback. Each kind supports a **round-robin** toggle (same semantics as the capacity
  adapter's `roundRobin`): the starting provider rotates across executions to spread usage over
  the pool, while failures still fall through in list order.
- `src/lib/db/repos/settingsRepo.js` — `webToolsAdapter: { webSearch, webFetch }`, each
  `{ enabled, roundRobin, providers }`. Defaults to **disabled** with an empty pool.
- Dashboard → Combo & Vision Adapter → **Web Tools Adapter**: per-kind enable toggle, round-robin
  toggle, provider pool with priority ordering and ready/needs-key badges.
- Tests: `tests/unit/webToolsAdapter.test.js` (engine + bridge, incl. round-robin rotation),
  `tests/unit/webToolsChatCore.test.js` (chatCore end-to-end for openai and claude targets).

### 📦 Provider / model catalogue maintenance
Fork-local model matrix and alias fixes; these deliberately diverge from upstream and are the
most likely source of merge conflicts in `capabilities.js` and `providers/registry/*`.

- `refactor: update provider configs, add models and fix aliases` (`976f644e`) — `ark-ap-provider`,
  `codebuddy-cn`, `qoder`/`qoder-cn`, `volcengine-ark`; trimmed `capabilities.js`.
- `feat(providers): add glm-5.3 and update capabilities` (`c670d261`)
- `chore(providers): remove deprecated glm-5.3 models and clean up cbcn config` (`ce23cd5f`)
- `feat(providers/registry): add deepseek-v4.1-flash model entries` (`8e3f5fe7`) — `alitp-cn`,
  `ark-ap-provider`, `volcengine-ark`.
- `feat(models, auth): add doubao-seed-2.1-lite model` (`e5e2075d`) — also `pricing.js` and a
  `dashboardSession.js` tweak.
- `feat(registry): add new model and fix import issues` (`b6fab54e`)
- `fix: clean up models, correct kimi-k3 format and add new ark-ap models` (`c26aca4f`)
- `refactor: simplify usage stats, add new models and unclassified support` (`9c7148c1`) — model
  additions alongside the usage rework above.

### 🏗️ Build / infra
- `chore: bump v0.5.40 and add upstream sync script` (`d8cad106`)
- `build: bump to v0.5.50, update next and slim build` (`aee5465a`) — slimmer standalone build,
  `next` 16.2.x, `build:standalone` script.
- `chore: sync pnpm-lock for upstream v0.5.99 deps (aws-sdk, enquirer)` (`dc2c94b2`)
- `chore: add pnpm-lock.yaml to .gitignore` (`c01c0359`) — the lockfile is no longer tracked.
- `docs: add FORK.md tracking 9router fork changes` (`7ba84621`)


## How to run

```bash
# Web dashboard (same as upstream)
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev

# Desktop app (Tauri) — this fork only
npm run tauri:dev      # dev with hot reload
npm run tauri:build    # packaged desktop app
```

## Syncing from upstream

```bash
git fetch upstream
git merge upstream/master   # or rebase; resolve conflicts mostly in src/
```

> Note: README.md is NOT modified by this fork. Desktop/Volcengine docs live here in FORK.md
> so upstream README updates can be merged without churn.

## Merge guide (where this fork touches upstream files)

Everything else is in **fork-only files** (new paths upstream does not have), which never
conflict: `open-sse/services/serverToolEmulator.js`, `open-sse/services/webToolsResponse.js`,
`src/sse/services/webToolsBridge.js`, `src/shared/components/WebToolsAdapterSection.js`,
`tests/unit/webTools*.test.js`, `FORK.md`, and the fork-only providers
(`open-design.js`, `ark-ap-provider.js`).

The edits to **upstream files** are intentionally small and self-contained — if a merge
conflicts, these are the only anchors to re-apply:

| Upstream file | Footprint | Anchor |
|---|---|---|
| `open-sse/handlers/chatCore.js` | ~80 lines | `handleChatCore` signature (`webToolsAdapter`, `executeServerTool` params); plan block right after the modality prefetch; `injectEmulatedTools` right after `dedupeTools`; the `if (emuPlan)` branch right after `sharedCtx`; the web-tool access-error fallback inside `if (!providerResponse.ok)` |
| `src/sse/handlers/chat.js` | 8 lines | import + `webToolsAdapter`/`executeServerTool` params in the `handleChatCore({…})` call |
| `src/lib/db/repos/settingsRepo.js` | 10 lines | `DEFAULT_SETTINGS.webToolsAdapter` (sits next to `capacityAdapter`) |
| `src/app/(dashboard)/dashboard/combos/page.js` | ~25 lines | import, one `useState`, one normalize call in `fetchData`, one save handler, one render line |
| `open-sse/translator/schema/blocks.js` | 1 line | `CLAUDE_BLOCK.WEB_FETCH_TOOL_RESULT` |
| `open-sse/utils/stream.js` | ~25 lines | passthrough block: track an upstream `[DONE]`, aggregate Claude `content_block_delta`; `createPassthroughStreamWithLogger` gains `sourceFormat` |
| `open-sse/handlers/chatCore/streamingHandler.js` | 1 line | pass `sourceFormat` as the 9th arg to `createPassthroughStreamWithLogger` |
| `open-sse/providers/capabilities.js` | ~63 lines | fork-added `PROVIDER_CAPABILITIES` blocks (`ark-ap-provider`, `volcengine-ark`, `opendesign`) plus the `qwen3.8` pattern; keep the keys aligned with the alias the web path passes |
| `open-sse/providers/registry/volcengine-ark.js` | ~10 lines (quirks + comments) | top-level `transport.quirks.responsesUnsupportedToolTypes`; no Claude whitelist (Claude wire always emulates) |
| `open-sse/providers/registry/ark-ap-provider.js` | ~10 lines (comments only) | fork-only provider — no Claude whitelist; Responses stays native |

`open-sse/providers/capabilities.js` is **not** zero-diff: the fork carries provider tables for
`ark-ap-provider`, `volcengine-ark` and `opendesign`, plus a `qwen3.8` pattern. It is one of the
highest-churn upstream files (60 commits since 2026-07-01), so a merge will usually conflict
there; re-apply the alias-keyed fork blocks on top of upstream's table.

Also worth knowing when syncing: `GET /v1/models` on open-design is **account-scoped** — it
lists what the current membership tier is entitled to, not the provider's full catalogue.
A model missing there (or shown "暂不支援" in the console) is plan-gated for that account;
an unentitled call answers `403 tier_model_not_entitled`. Keep the provider-level model list
complete and let entitlement fail at request time.

