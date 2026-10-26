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

- Native support reuses existing pipeline config — **no new capability flag**:
  `capabilities.js` is untouched (byte-identical to upstream) and the decision is
  "will the server tool actually reach the upstream?":
  - native passthrough (`anthropic`, `anthropic-compatible-*`) → the tool rides through;
  - a Claude transport whose `quirks.claudeSupportedToolTypes` whitelists **every**
    requested type (DeepSeek's Anthropic endpoint, and now `ark-ap-provider` for
    `web_search`) → `prepareClaudeRequest` forwards it;
  - everything else emulates. This matters because `prepareClaudeRequest` strips
    non-function tools for every other provider, so a Claude-format wire alone is
    not native support: the model's `search` flag being true (all Claude/GPT ids
    resolve that way) does not change the fact that the tool would be deleted
    before dispatch. Partial whitelist coverage also emulates, since the uncovered
    tool would otherwise vanish.
  - The OpenAI wire has no Anthropic server tool type at all, so it always emulates.
  - **Live probe (2026-10-26)** — which upstreams really execute the tools:

    | endpoint | `web_search_20250305` | `web_fetch_20250910` |
    |---|---|---|
    | `anthropic` | native | native |
    | `ark-ap-provider` (Agent Plan, `/api/plan/v1/messages`) | **native** — `server_tool_use` + `web_search_tool_result`; also `web_search_20260209` | HTTP 400 `unsupported server tool web_fetch` |
    | `volcengine-ark` (coding plan) | HTTP 403 `Access denied for web search … verify the activation status` (type understood, account not entitled) | untested |
    | `open-design` (`/v1/messages`, all Claude ids) | HTTP 400 `unsupported Responses tool type "web_search" … on Chat route` | HTTP 400, same |

    Recorded in the registry: `ark-ap-provider` gains
    `quirks.claudeSupportedToolTypes: ["web_search_20250305", "web_search_20260209"]`
    (top-level `transport`, which is what `providers/index.js` publishes); `web_fetch`
    stays out so it keeps emulating, and a request asking for both emulates the whole set.
    The other two carry comments explaining why they must not be whitelisted — the coding-plan
    403 is an entitlement gate that would surface as a hard error rather than fall back to
    emulation, and open-design normalizes every request onto its internal Chat route.
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
