# FORK NOTES — 9Router (local / dev branch)

This document tracks changes carried on this fork's development branch (`dev`, formerly `local`),
which is ahead of upstream `master` (`decolua/9router`). It is intentionally kept separate from
the upstream `README.md` to avoid merge conflicts when syncing from upstream.

## Branch

- `dev` (was `local`) — this fork's development line, tracks the 0.5.x feature work.
- Rebased/synced against upstream `master` via `scripts/upstream-sync` (see commit `31ab3181`).

## Changes vs upstream `master`

Based on the 13 commits unique to this branch (etest 2026-07-10 → 2026-08-06):

### 🖥️ Desktop app (Tauri 2)
- `feat(desktop): add tauri desktop app support and accompanying tweaks` (`1bcef5a9`)
- Added `src-tauri/` (Rust shell, icons, `tauri.conf.json`, `Cargo.toml`, `main.rs`).
- npm scripts: `tauri:dev`, `tauri:build` (see `package.json`).
- `feat(tray): add lightweight mode toggle and supporting app handling` (`014a400c`)
- `refactor: fix pxpipe and improve tray menu` (`e14e4824`)
- `chore: ignore Rust/Tauri build artifacts` (`8559cbf4`)
- Shared UI additions to support the desktop shell: `TrafficLights.js`, `CloseConfirmModal.js`,
  tray/lightweight-mode handling in `DashboardLayout.js`, and a self-hosted `open` launcher tweak.

### 🔌 Volcengine / Ark integration
- `feat: add support for volcengine agent plan provider` (`93118ef1`)
- `feat: add volcengine sso provider support` (`efc5633d`) — `src/lib/oauth/providers/volcengine-sso.js`, `src/lib/volcengine/ssoLogin.js`
- `feat(volcengine-ark): add long-lived IAM AK/SK and OpenAPI usage/billing` (`5356a053`)
- `feat(volcengine): add claude support, fix provider sync` (`65e78e92`)
- `fix(ark): update claude urls to v1/messages paths` (`4552a44f`)
- `feat(ark-ap-provider): add doubao-seed-evolving model` (`8c9648d2`)
- New API routes: `src/app/api/usage/ark-billing/route.js`, `src/app/api/usage/ark-plans/route.js`
- Dashboard panel: `components/ProviderLimits/ArkOpenApiPanel.js`
- `open-sse` backend additions: `volcengine-ark.js`, `volcengine-ark-openapi.js`, `signerV4.js`
  (V4 request signing for Volcengine), plus reasoning/streaming utilities.

### 🔁 Streaming / tool / reasoning improvements
- `feat: add streaming reliability, tool handling, and reasoning improvements` (`a0f3eb0b`)
- `open-sse/utils/stream.js`, `reasoningCache.js`, `textualToolCall.js`, translator schema/tool-call coercions.

### 🏗️ Build / infra
- `chore: bump v0.5.40 and add upstream sync script` (`31ab3181`)
- `build: bump to v0.5.50, update next and slim build` (`77412827`) — slimmer standalone build,
  `next` 16.2.x, `build:standalone` script.

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
