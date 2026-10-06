# Zippy

Agentic task manager: tickets → Claude Code agents (via ACP) → you verify. See [PLAN.md](PLAN.md).

## Run

```bash
pnpm install
pnpm db:push        # schema → postgres://postgres@127.0.0.1:5432/zippy (.env)
pnpm dev            # server :3001, web http://localhost:5199
```

Start it from your own terminal: agents use your local `claude` CLI and its login (`claude auth login`). No API key is stored.

Desktop app (Tauri, needs Rust): `pnpm desktop` runs it against the repo sources. Shareable build: `pnpm --filter @zippy/desktop build` → `apps/desktop/src-tauri/target/release/bundle/dmg/Zippy_<ver>_aarch64.dmg` (bundles Node, server, web; Apple Silicon only). Users still need `claude`, `git` and `gh` installed. Built-in Postgres downloads on first run; Settings → Database switches to your own.

Schema changes: `pnpm db:push` for your dev DB, then `pnpm --filter @zippy/server db:generate` and commit `apps/server/drizzle/`. The desktop app only applies migrations.

Linear: copy the `LINEAR_*` keys from `.env.example` into `.env`, restart, then Settings → Linear → Connect.

Quick capture: `pnpm link --global` once, then `zippy "fix login redirect"` from any repo files an issue under that folder. The desktop tray has New issue… too.

Tests: `pnpm --filter @zippy/server test`

## Layout

- `apps/server` — Hono API, SSE, Drizzle/Postgres, `runner.ts` (ACP process per ticket+agent)
- `apps/web` — Vite + React, shadcn/ui, TanStack Query, zustand
- `apps/desktop` — Tauri shell: supervises the server + built-in Postgres
- `packages/shared` — zod schemas + types used by both
