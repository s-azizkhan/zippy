# Zippy

Agentic task manager: tickets → Claude Code agents (via ACP) → you verify. See [PLAN.md](PLAN.md).

## Run

```bash
pnpm install
pnpm db:push        # schema → postgres://postgres@127.0.0.1:5432/zippy (.env)
pnpm dev            # server :3001, web http://localhost:5199
```

Start it from your own terminal: agents use your local `claude` CLI and its login (`claude auth login`). No API key is stored.

Desktop app (Tauri, needs Rust): `pnpm desktop`. Starts the server as a sidecar on :3311 with a built-in Postgres (first run downloads it). Settings → Database, or the first-run wizard, switches to your own Postgres (test connection, create database). Dev layout only; bundling Node is not done yet.

Linear: copy the `LINEAR_*` keys from `.env.example` into `.env`, restart, then Settings → Linear → Connect.

Tests: `pnpm --filter @zippy/server test`

## Layout

- `apps/server` — Hono API, SSE, Drizzle/Postgres, `runner.ts` (ACP process per ticket+agent)
- `apps/web` — Vite + React, shadcn/ui, TanStack Query, zustand
- `apps/desktop` — Tauri shell: supervises the server + built-in Postgres
- `packages/shared` — zod schemas + types used by both
