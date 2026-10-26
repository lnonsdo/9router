# FORK NOTES — 9Router (local / dev branch)

This document tracks changes carried on this fork's development branch (`dev`, formerly `local`),
which is ahead of upstream `master` (`decolua/9router`). It is intentionally kept separate from
the upstream `README.md` to avoid merge conflicts when syncing from upstream.

## Branch

- `dev` (was `local`) — this fork's development line, tracks the 0.5.x feature work.
- Rebased/synced against upstream `master` via `scripts/upstream-sync` (see commit `d8cad106`).

## Changes vs upstream `master`

34 commits unique to `dev` as of 2026-10-24 (range 2026-07-10 → 2026-10-24), grouped by area.
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

### 🔁 Streaming / tool / reasoning improvements
- `feat: add streaming reliability, tool handling, and reasoning improvements` (`b3378a01`)
- `open-sse/utils/stream.js`, `reasoningCache.js`, `textualToolCall.js`, translator schema/tool-call coercions.

### 🌐 Web Tools Adapter (server tool emulation)
Targets that cannot run Anthropic server tools natively keep working web search/fetch:
Claude clients (e.g. Claude Code) routed to OpenAI-compatible backends **or** third-party
Claude-compatible endpoints get the tools emulated in the gateway instead of silently losing them.

- **Scope: the emulator only sees Claude-format clients.** `planServerToolEmulation`
  returns null for every other source format, so a Codex / Responses request is never
  emulated by it. Native support is therefore a **per-wire** question, not a
  per-provider one:
  - **Claude wire** (`POST /v1/messages` → the provider's `format: "claude"` transport):
    - native passthrough (`anthropic`, `anthropic-compatible-*`) → the tool rides through;
    - a provider whose top-level `transport.quirks.claudeSupportedToolTypes` whitelists
      **every** requested type (DeepSeek, both Ark endpoints for `web_search`) →
      `prepareClaudeRequest` forwards it;
    - everything else emulates. This matters because `prepareClaudeRequest` strips
      non-function tools for every other provider, so a Claude-format wire alone is
      not native support: the model's `search` flag being true (all Claude/GPT ids
      resolve that way) does not change the fact that the tool would be deleted
      before dispatch. Partial whitelist coverage also emulates, since the uncovered
      tool would otherwise vanish.
  - **Codex / Responses wire** (`POST /v1/responses` → the provider's
    `format: "openai-responses"` transport): when the provider declares that transport,
    `sourceFormat === targetFormat`, `translateRequest` is a no-op and the hosted tool
    `{ type: "web_search" }` reaches the upstream **untouched**. No whitelist is involved
    and the adapter never runs. The coding-plan endpoint documents this path, so Codex
    web search is native there without any fork code — only the 豆包搜索 entitlement
    gate applies. (`ark-ap-provider` also exposes `/responses`, but its hosted-search
    support is not covered by that doc and was not probed.) (If a provider has no
    Responses transport, the body is pivoted through OpenAI Chat instead, where hosted
    tools are dropped — see the gap note below.)
  - **OpenAI Chat wire**: no Anthropic server tool type at all, so it always emulates
    (this only matters for Claude clients translated onto that wire).
  - **Not covered in v1:** a Responses client routed to an endpoint that rejects hosted
    web search (open-design, probed 400) gets the upstream error — there is no emulation
    fallback for Responses sources.
  - **Live probe (2026-10-26), Claude wire** — which upstreams really execute the
    Anthropic server tools when a Claude client hits their `/v1/messages`:

    | endpoint | `web_search_20250305` | `web_fetch_20250910` |
    |---|---|---|
    | `anthropic` | native | native |
    | `ark-ap-provider` (Agent Plan, `/api/plan/v1/messages`) | **native** — `server_tool_use` + `web_search_tool_result`; also `web_search_20260209` | HTTP 400 `unsupported server tool web_fetch` |
    | `volcengine-ark` (coding plan, `/api/coding/v1/messages`) | **native per docs**, but the account must activate 豆包搜索 Custom 版 (控制台 > 开通管理 > 应用组件库 > 豆包搜索); unactivated accounts get HTTP 403 `Access denied for web search … verify the activation status` | not offered |
    | `open-design` (`/v1/messages`, all Claude ids) | HTTP 400 `unsupported Responses tool type "web_search" … on Chat route` (also with `anthropic-beta: web-search-2025-03-05`, and on `/v1/responses` with the hosted tool) | HTTP 400, same |

    Doc reference for the coding plan (Claude wire):
    `console.volcengine.com/ark/region:cn-beijing/docs/coding-plan-personal-ai-claude-code.md`
    §"使用 Claude Code 的 Web Search 功能" — "通过 Messages API 接入的 Claude Code 也可原生使用 Web Search 功能".

    The **Codex wire is a different mechanism and needs no fork config**: the
    `coding-plan-personal-ai-codex.md` doc says "通过 Responses API 接入的 Codex 也可原生使用
    Web Search 功能", i.e. the client's hosted `{ "type": "web_search" }` tool on
    `POST /api/coding/v3/responses`. `resolveTransport(provider, "openai-responses")`
    selects the matching transport, `sourceFormat === targetFormat` skips translation,
    so the tool is forwarded verbatim. Same 豆包搜索 Custom 版 activation gate; the doc
    also notes each search triggers an extra model call to summarize the results.
    Doc: `console.volcengine.com/ark/region:cn-beijing/docs/coding-plan-personal-ai-codex.md`.

    Both Ark providers declare
    `quirks.claudeSupportedToolTypes: ["web_search_20250305", "web_search_20260209"]`
    on their **top-level `transport`** (that is what `providers/index.js` publishes; a quirk on a
    `transports[]` entry is invisible to `prepareClaudeRequest`). `web_fetch` stays out because
    neither endpoint offers it, so fetch keeps emulating and a request asking for both emulates
    the whole set. Open Design carries a comment explaining why it must not be whitelisted: it
    normalizes every request onto its internal Chat route.
    Consequence for the coding plan: an account without 豆包搜索 Custom activated sees the
    provider's own 403 for `web_search` requests instead of falling back to emulation.
- `open-sse/services/serverToolEmulator.js` — detection, history downgrade, tool injection,
  the emulation loop and the client-facing SSE synthesizer:
  - Emulated rounds run upstream **non-streaming** (the loop buffers complete rounds), then the
    client gets standard `server_tool_use` / `web_search_tool_result` / `web_fetch_tool_result`
    blocks restored in SSE or JSON shape.
  - Tool injection, round appends and response parsing are per target format (OpenAI `function`
    tools vs Claude `input_schema` tools). Anthropic-format SSE upstreams are aggregated;
    OpenAI-shaped responses from misbehaving Claude endpoints still parse.
  - Replayed history blocks are downgraded to a plain tool loop per turn, with `srvtoolu_` ids
    rewritten to the `toolu_` namespace so strict Claude-compatible endpoints accept them.
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
| `open-sse/handlers/chatCore.js` | ~30 lines | `handleChatCore` signature (`webToolsAdapter`, `executeServerTool` params); plan block right after the modality prefetch; `injectEmulatedTools` right after `dedupeTools`; the `if (emuPlan)` branch right after `sharedCtx` |
| `src/sse/handlers/chat.js` | 8 lines | import + `webToolsAdapter`/`executeServerTool` params in the `handleChatCore({…})` call |
| `src/lib/db/repos/settingsRepo.js` | 10 lines | `DEFAULT_SETTINGS.webToolsAdapter` (sits next to `capacityAdapter`) |
| `src/app/(dashboard)/dashboard/combos/page.js` | ~25 lines | import, one `useState`, one normalize call in `fetchData`, one save handler, one render line |
| `open-sse/translator/schema/blocks.js` | 1 line | `CLAUDE_BLOCK.WEB_FETCH_TOOL_RESULT` |
| `open-sse/providers/registry/volcengine-ark.js` | ~18 lines (quirks + comments) | top-level `transport.quirks.claudeSupportedToolTypes`; Claude wire only — Codex already passes through via the `openai-responses` transport |
| `open-sse/providers/registry/ark-ap-provider.js` | ~18 lines | fork-only provider — `transport.quirks.claudeSupportedToolTypes` |

`open-sse/providers/capabilities.js` has **zero** diff from upstream by design (the adapter
reuses `search` / `claudeSupportedToolTypes` instead of adding a capability).

Also worth knowing when syncing: `GET /v1/models` on open-design is **account-scoped** — it
lists what the current membership tier is entitled to, not the provider's full catalogue.
A model missing there (or shown "暂不支援" in the console) is plan-gated for that account;
an unentitled call answers `403 tier_model_not_entitled`. Keep the provider-level model list
complete and let entitlement fail at request time.

