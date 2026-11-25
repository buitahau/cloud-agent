# Admin dashboard rewrite: React + Ant Design

Replace the vanilla-JS admin dashboard (`src/admin/public/`) with a React + Ant Design single-page app.
Like-for-like, **read-only** port — no new actions. API shapes are unchanged.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Stack | Vite + React 19 + TypeScript + antd v6, react-router, @tanstack/react-query | Current stable; no React-19 compat patch needed |
| Location | Standalone `web/` folder with its own `package.json` (not a workspace) | Server runtime deps stay `express` + `dotenv` |
| Node | `web/` needs Node ≥ 22.22 (react-router 8; Vite 8 needs ≥ 20.19); server stays ≥ 18.20 | Build is a separate step |
| CSP | Add `style-src 'self' 'unsafe-inline'` | antd injects runtime `<style>` tags; scripts stay `'self'`-only |
| Routing | Clean URLs `/admin/...` (`basename: '/admin'`) + SPA fallback in Express | Real URLs, back button, deep links |
| Build output | `web/dist/`, gitignored; `npm run build` before `npm start` | No generated files in diffs; Express returns 503 "not built" if missing |
| Polling | TanStack Query `refetchInterval: 5000`; jobs list polls only while one page is loaded | Avoid refetching every loaded page |
| SSE | Custom `useJobEvents` hook over `EventSource` (Basic auth resent by browser) | No library needed |
| Safety | React escaping only; never `dangerouslySetInnerHTML` (enforced by test) | Job text is untrusted |

## Steps

Status: **all five steps done** (verified with `npm test` and headless-Chromium checks against the production build).

### Step 1 — Scaffold `web/`
- Vite react-ts app in `web/` with antd, react-router, @tanstack/react-query.
- `vite.config.ts`: `base: '/admin/'`, dev proxy `/admin/api` → `http://localhost:8080`, `build.assetsInlineLimit: 0`.
- Root scripts: `dev:web`, `build:web`, `build`, `test:web` (typecheck). `.gitignore`: `web/dist/`.
- **Done when:** `npm run build:web` produces `web/dist/index.html` + `web/dist/assets/*`.

### Step 2 — Serve the SPA from Express (`src/admin.js`)
- `deps.publicDir` (default `web/dist`); `/assets` served `immutable, maxAge 1y`; `index.html` `no-cache`.
- SPA fallback: extension-less `GET /admin/*` → `index.html`; missing assets → 404; `/admin/api/*` unknown → JSON 404.
- 503 "dashboard not built: run `npm run build:web`" when `index.html` is missing.
- CSP gains `style-src 'self' 'unsafe-inline'`.
- Tests: fixture dir `test-support/admin-fixture/`, new fallback/asset/CSP assertions, port the no-innerHTML test to scan `web/src/**/*.{ts,tsx}`.
- **Done when:** `npm test` is green.

### Step 3 — Foundation, layout and Overview page
- `api/client.ts` (base from `location.origin`, `ApiError`), `api/types.ts`, `api/queries.ts`, `lib/format.ts` (port of `ago/dur/money/upt/describe`).
- `StatusTag`, `HealthTag`, `AppLayout` (header menu, "updated" stamp, dark mode via `prefers-color-scheme`), router.
- `OverviewPage` (stats + repo cards) and `RepoCard`.
- **Done when:** production build loads at `http://localhost:8080/admin/` with styles (CSP verified).

### Step 4 — Jobs list and Repo page
- `JobsTable` (infinite query, "Load more", repo + multi-status filters in search params, polling).
- `JobsPage`, `RepoPage` (breadcrumb, repo card, details, jobs table with fixed repo, 404 result).
- **Done when:** filters, paging and repo drill-down match the old dashboard.

### Step 5 — Job detail with live events, cleanup, docs
- `useJobEvents` (dedupe by seq, rAF-batched flush, cap 2000, close on `result` and on error when terminal, invalidate queries).
- `JobPage`: meta, status timeline, error, prompt/result, `EventStream` (type tags, tool use/result, gap, sticky auto-scroll), log.
- Delete `src/admin/public/`; update README, ARCHITECTURE.md, MULTI_REPO_PLAN.md, admin.js header.
- **Done when:** live job, finished job (no reconnect loop) and HTML-in-prompt (rendered as text) all behave correctly.

## Out of scope (follow-ups)
- Job submission / cancel (needs CSRF guard and worker abort path).
- Per-event timestamps in SSE (additive `at` field on the shared stream).
