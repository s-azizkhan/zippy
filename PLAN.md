# Zippy — Plan v1

Lite Paperclip for teams that already run on Linear + GitHub. Zippy does not replace your tools; it puts agent coworkers inside them.

- Declare intent = a Linear ticket.
- Agents work = a pipeline of role agents (validator → planner → executor → reviewers) on Claude Code via ACP.
- You verify = diffs, tests, screenshots, decision cards. One inbox.

---

## 1. Stack

| Layer | Choice |
|---|---|
| Web | Vite + React + TS, shadcn/ui (Radix), Tailwind, TanStack Query, zustand (UI state only), zod, cmdk, react-hook-form |
| Server | Node 22 + Hono, SSE for streams, REST for writes |
| DB | Local Postgres, new DB `zippy`, Drizzle ORM + drizzle-kit migrations |
| Agent runtime | `@agentclientprotocol/claude-agent-acp` → local `claude` CLI (detected: 2.1.287). Fallback: Claude subscription login through the adapter |
| Tracker | Linear = source of truth. Linear MCP is a default MCP server for every agent. App-side sync via `@linear/sdk` + webhooks (MCP is for agents; webhooks need the API) |
| Git | `git worktree` per ticket, `gh` CLI for PRs/CI |

Monorepo (pnpm):

```
zippy/
  apps/web        Vite app
  apps/server     Hono + RunManager + Zippy MCP server
  packages/shared zod schemas + types (one source for API contracts)
```

---

## 2. Concepts

- **Org**: Linear team(s), GitHub owner, org context (markdown), default MCP servers, default model.
- **Workspace**: a working folder (repo path, base branch, setup/test commands), workspace context (markdown), extra MCP servers.
- **Agent**: an org-scoped AI employee with a handle (`@reviewer`), a role prompt (markdown, see §4), a model, a permission policy, an MCP allowlist and an avatar.
- **Pipeline (loop)**: an ordered set of stages with routing rules. Triggered on ticket create, on a label, or manually.
- **Ticket**: a mirror of a Linear issue, or local-only. Owns one worktree, one branch, one PR, and N agent sessions.

### Context layering (injected on every agent session)

```
org context → workspace context → repo CLAUDE.md → agent role prompt
→ ticket (title, body, Linear comments, linked issues) → handoff notes from prior stage
```

Appended to the Claude Code system prompt via the ACP `_meta.systemPrompt.append` (verify in P0), so the adapter keeps its normal Claude Code tooling.

---

## 3. Data model (Postgres)

| Table | Key fields |
|---|---|
| `org` | name, slug, linear_team_ids[], gh_owner, context_md, default_model |
| `workspace` | org_id, name, path, repo_remote, base_branch, setup_cmd, test_cmd, context_md |
| `mcp_server` | org_id, workspace_id?, name, transport (stdio/http), command/args/url, env_enc (encrypted), is_default |
| `agent` | org_id, handle, name, role_prompt_md, model, permission_policy (jsonb), mcp_ids[], can_write bool, avatar |
| `pipeline` | org_id, name, trigger (jsonb), max_loops |
| `pipeline_stage` | pipeline_id, position, agent_id, on_pass (next/stage_id/done), on_fail (stage_id), gate (auto/human) |
| `ticket` | org_id, workspace_id, linear_id?, identifier, title, body, status, priority, assignee_agent_id?, pipeline_id?, current_stage_id?, loop_count, worktree_path, branch, pr_url |
| `agent_session` | ticket_id, agent_id, acp_session_id, status — one session per (ticket, agent), so each agent keeps its own memory across loops |
| `comment` | ticket_id, author_type (user/agent/system), agent_id?, kind (text/plan/tool/approval/handoff/diff/pr/status/doc), payload jsonb, linear_comment_id? |
| `handoff` | ticket_id, from_stage, verdict (pass/fail), summary, notes, created_at |
| `approval` | ticket_id, agent_id, tool_call jsonb, options jsonb, decision, decided_at |
| `run` | agent_session_id, started/ended, tokens_in/out, cost_usd, outcome |
| `document` | ticket_id, agent_id, title, body_md, version — "produce a real artifact" lands here |

---

## 4. Agents

Seeded defaults (editable, cloneable):

| Handle | Job | Write access |
|---|---|---|
| `@validator` | Checks the ticket is clear and doable. Adds missing context (code refs, repro, acceptance criteria). Fails back to the human if blocked. | read-only |
| `@planner` | Writes the implementation plan as a ticket document. | read-only |
| `@executor` | Implements in the worktree, runs tests, later opens the PR. | write |
| `@reviewer` | Reviews the diff against the plan + acceptance criteria. | read-only |
| `@security` | Security review of the diff (secrets, authz, injection, money paths). | read-only |
| `@cto` (example) | Chief of staff: talks to the user, proposes and coordinates work. | read-only |

Agent editor UI: name, handle, avatar, role prompt (markdown editor with preview), model picker, permission policy, MCP checkboxes, "Test run" against a sample ticket.

### Zippy MCP server (the agents' "Paperclip tools")

Injected into every session. This is how agents act on the board instead of only chatting:

- `zippy.comment(body)` — post to the ticket timeline
- `zippy.handoff({ verdict: "pass"|"fail", summary, notes })` — end the stage; drives routing
- `zippy.ask_user({ question, options[], recommended })` — creates a decision card, ticket → Needs Input
- `zippy.save_document({ title, body_md })` — attach a plan/brief to the ticket
- `zippy.mention(handle, message)` — tag another agent
- `zippy.update_ticket({ status?, priority?, labels? })`

---

## 5. Pipeline engine

Default pipeline (your loop):

```
Ticket created
  → @validator   pass → @planner        fail → human (Needs Input)
  → @planner     pass → @executor
  → @executor    pass → @reviewer
  → @reviewer    pass → @security       fail → @executor (with notes)
  → @security    pass → @executor:pr    fail → @executor (with notes)
  → @executor:pr opens PR → In Review → merged → Done
```

Rules:
- A stage ends only when the agent calls `zippy.handoff`. A session that ends without one counts as fail ("no verdict").
- On fail: post a handoff comment that tags the target agent with what is wrong, then re-prompt that agent's existing session (it remembers its prior work).
- `max_loops` (default 3) on fail cycles. When it is hit, stop and create a decision card for the human.
- Any stage can be `gate: human`: it waits for your approve/reject in the inbox before routing.
- Manual override anytime: reassign, skip a stage, re-run, or `@agent` in a comment.

### Loop builder UI

A vertical stage list, not a canvas, because a canvas is weak for keyboard and screen-reader users. Each row has: agent picker, "on pass → …", "on fail → …", gate toggle. Drag to reorder with keyboard support (dnd-kit). A read-only flow diagram is shown beside it as a preview.

### Mentions

- `@handle` in any comment, from a human or an agent, prompts that agent's session on this ticket with the comment plus ticket context.
- Assigning a ticket to an agent starts it.

---

## 6. Ticket status ↔ Linear

| Event | Zippy / Linear state |
|---|---|
| Pipeline started | In Progress |
| `ask_user` / permission request / max loops | Needs Input (custom Linear state, or the label `needs-input`) |
| PR opened | In Review |
| CI failed | In Progress (executor auto-fix, counts toward max_loops) |
| PR merged | Done |
| Crash / cancel | Blocked |

- Agent comments go to Linear as the Zippy OAuth app, with `createAsUser` = agent name and `displayIconUrl` = agent avatar, so each agent shows as its own author.
- Streamed text is batched to one Linear comment per turn.
- The PR title gets the `COM-123` prefix so Linear's GitHub integration auto-links it. The PR body gets the summary, a link to the plan doc, and review verdicts.

---

## 7. Runtime and safety

- One ACP child process per active `agent_session`, with a global concurrency cap and a queue. Idle sessions are killed and later resumed with `loadSession`.
- Every write-capable agent shares the ticket worktree. Read-only agents get a permission policy that denies edit/write/bash-write.
- Permission policy, evaluated server-side in `requestPermission`:
  - Auto-allow: reads, and edits inside the worktree (write agents only).
  - Ask: `git push`, network calls, package installs, anything outside the worktree.
  - Deny: `.env*`, secrets paths, `rm -rf` outside the worktree.
- MCP env secrets are encrypted at rest (key in the macOS keychain) and never sent to the browser.
- Claude auth: use the local `claude` CLI and its existing login. If it is missing, run the adapter's login flow (subscription). No API key is stored by Zippy.

---

## 8. UI (Linear-like)

- **Sidebar**: org switcher, Inbox, My tickets, Active runs, Workspaces, Agents, Pipelines, Settings.
- **Ticket list / board**: dense rows, status icons, agent avatars on the current stage, a live "working" pulse.
- **Ticket detail**: timeline (comments, agent streams, tool rows, handoff cards, decision cards) plus a right panel (status, stage stepper, workspace, branch, PR, cost, files changed). The composer supports `@agent` autocomplete.
- **Inbox**: decision cards (TL;DR, options, recommended), approvals, PRs to review. Clear it with `J/K`, `A` (approve), `R` (reject), `E` (reply).
- **Keyboard**: `⌘K` palette, `C` new ticket, `S` status, `⇧A` assign agent, `G I` go to inbox.
- **Accessibility**: Radix primitives, visible focus rings, a throttled `aria-live="polite"` region for agent streams, `prefers-reduced-motion` respected, AA contrast in light and dark, every action reachable from the keyboard.

---

## 9. Productivity extras (ranked)

1. **Decision cards** — agents must give options plus a recommendation; you decide in one key press.
2. **Verify panel** — diff, test output, and screenshots (Playwright against the dev server) on the ticket.
3. **Risk flags** — per-workspace sensitive paths (payments, migrations); a diff that touches them forces `gate: human` before the PR.
4. **CI auto-fix + PR review loop** — failing checks and GitHub review comments flow back to `@executor`.
5. **Org memory** — after each ticket, the agent proposes "learnings"; you accept them into org/workspace context in one click.
6. **Parallel tickets** — isolated worktrees and a queue.
7. **Routines** — cron pipelines (dependency bumps, Sentry triage → tickets).
8. **Cost guardrails** — budget per ticket and per agent; pause and ask when exceeded.
9. **Ticket splitter** — `@planner` can create Linear sub-issues with dependencies.
10. **Notifications** — Slack or desktop when Needs Input or a PR is ready.

---

## 10. Phases

| Phase | Scope | Done when |
|---|---|---|
| **P0 Core** | Monorepo, Postgres `zippy` + Drizzle, org/workspace/MCP/agent CRUD, context editors, RunManager (ACP spawn, local CLI detection, stream → comments, `loadSession` resume), ticket timeline UI, reply → prompt | A local ticket is worked by `@executor`, the chat survives a server restart |
| **P1 Pipeline + Linear** | Zippy MCP server, handoff routing, loop builder, @mentions, permission policy + approvals, Linear import/sync/status, worktrees, PR creation + linking | A Linear ticket runs the full default loop to an opened PR |
| **P2 Decide fast** | Inbox + decision cards, verify panel, CI auto-fix, PR review loop, cost tracking, risk flags | Daily driver |
| **P3** | Org memory, routines, splitter, notifications, agent test runs / evals | — |

---

## 11. Open items

- Local Postgres on `127.0.0.1:5432` (TablePro "postgres" connection) is not running. Start it in DBngin, then create DB `zippy`.
- Linear: a Zippy OAuth app (for `createAsUser` agent identities + webhooks), or a personal API key for P0–P1 (comments show as you, prefixed with `[@agent]`).
- Verify in P0: the adapter's support for the local executable path and for `_meta.systemPrompt.append`.
