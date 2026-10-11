import { boolean, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  key: text("key").notNull().unique(), // ticket prefix, e.g. ZIP
  contextMd: text("context_md").notNull().default(""),
  defaultModel: text("default_model").notNull().default("default"),
  defaultEffort: text("default_effort").notNull().default("default"),
  cacheTtl: text("cache_ttl").notNull().default("5m"), // prompt cache lifetime: 5m, or 1h (costlier writes, stays warm across slow replies)
  idleMinutes: integer("idle_minutes").notNull().default(10), // kill idle agent process after this long; restored on next prompt
  maxLive: integer("max_live").notNull().default(0), // max live agent processes for the org; 0 = no cap
  ticketSeq: integer("ticket_seq").notNull().default(0),
  toggles: jsonb("toggles").$type<Record<string, boolean>>().notNull().default({}),
  budgetUsd: real("budget_usd"), // per-ticket agent spend cap; null = no cap
  linearAuth: jsonb("linear_auth").$type<import("../linear.ts").LinearAuth>(), // Linear MCP OAuth client + tokens
  linearWorkspace: text("linear_workspace"),
  linearPush: boolean("linear_push").notNull().default(true),
  profile: jsonb("profile").$type<import("@zippy/shared").Profile>().notNull().default({ name: "", handle: "", role: "", githubUsername: "", githubEmail: "", linearUser: "", about: "", dayStart: "00:00" }),
  slackWebhookUrl: text("slack_webhook_url").notNull().default(""),
  notifyDesktop: boolean("notify_desktop").notNull().default(true),
  useActiveBranch: boolean("use_active_branch").notNull().default(false), // work in the folder on its checked-out branch, no worktree
  createdAt: createdAt(),
});

export const workspaces = pgTable("workspaces", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  path: text("path").notNull(),
  baseBranch: text("base_branch").notNull().default("main"),
  setupCmd: text("setup_cmd").notNull().default(""),
  testCmd: text("test_cmd").notNull().default(""),
  contextMd: text("context_md").notNull().default(""),
  riskPaths: text("risk_paths").array().notNull().default([]), // path prefixes/globs that need human approval before a PR
  createdAt: createdAt(),
});

export const mcpServers = pgTable("mcp_servers", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  // empty = all folders
  workspaceIds: jsonb("workspace_ids").$type<string[]>().notNull().default([]),
  name: text("name").notNull(),
  transport: text("transport").$type<"stdio" | "http">().notNull(),
  command: text("command").notNull().default(""),
  args: jsonb("args").$type<string[]>().notNull().default([]),
  url: text("url").notNull().default(""),
  // ponytail: plaintext, local single-user; encrypt at rest before multi-user.
  env: jsonb("env").$type<Record<string, string>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

export const agents = pgTable(
  "agents",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    handle: text("handle").notNull(),
    rolePromptMd: text("role_prompt_md").notNull().default(""),
    model: text("model").notNull().default("default"),
    effort: text("effort").notNull().default("default"), // default = org default
    canWrite: boolean("can_write").notNull().default(false),
    color: text("color").notNull().default("#6366f1"),
    toggles: jsonb("toggles").$type<Record<string, boolean>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agents_org_handle").on(t.orgId, t.handle)],
);

export const pipelines = pgTable("pipelines", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  autoStart: boolean("auto_start").notNull().default(false), // start on ticket create
  labelIds: uuid("label_ids").array().notNull().default([]), // start on ticket create when it has one of these labels; wins over autoStart
  maxLoops: integer("max_loops").notNull().default(3),
  createdAt: createdAt(),
});

// onPass: "next" | "done" | stage id. onFail: "human" | stage id.
export const pipelineStages = pgTable("pipeline_stages", {
  id: id(),
  pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  name: text("name").notNull(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  instruction: text("instruction").notNull().default(""),
  onPass: text("on_pass").notNull().default("next"),
  onFail: text("on_fail").notNull().default("human"),
  humanGate: boolean("human_gate").notNull().default(false),
});

export const tickets = pgTable("tickets", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
  assigneeHuman: boolean("assignee_human").notNull().default(false),
  identifier: text("identifier").notNull(),
  kind: text("kind").$type<"ticket" | "chat">().notNull().default("ticket"), // chat = free-form conversation with an agent, hidden from the board
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  status: text("status").notNull().default("todo"),
  priority: text("priority").notNull().default("none"),
  labelIds: uuid("label_ids").array().notNull().default([]),
  linearId: text("linear_id"),
  linearUrl: text("linear_url"),
  pipelineId: uuid("pipeline_id").references(() => pipelines.id, { onDelete: "set null" }),
  stageId: uuid("stage_id").references(() => pipelineStages.id, { onDelete: "set null" }),
  loopCount: integer("loop_count").notNull().default(0),
  riskApproved: boolean("risk_approved").notNull().default(false),
  archived: boolean("archived").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete; comments/sessions/folders/runs hang off the ticket and vanish with it
  parentId: uuid("parent_id"), // sub-issue of
  routineId: uuid("routine_id").references(() => routines.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("tickets_org_identifier").on(t.orgId, t.identifier)]);

// Working folders on a ticket. Position 0 is the agent's cwd; the rest are extra dirs. Each gets its own worktree + PR.
export const ticketFolders = pgTable(
  "ticket_folders",
  {
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    worktreePath: text("worktree_path"),
    branch: text("branch"),
    prUrl: text("pr_url"),
    prTitle: text("pr_title"),
    prState: text("pr_state"), // OPEN | MERGED | CLOSED
    ciHandledSha: text("ci_handled_sha"), // head sha whose failed checks were already sent to an agent
    reviewSeenAt: timestamp("review_seen_at", { withTimezone: true }), // PR review comments after this are new
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.workspaceId] })],
);

export const labels = pgTable("labels", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("#6b7280"),
  createdAt: createdAt(),
});

// One ACP session per (ticket, agent): each agent keeps its own memory on a ticket.
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: id(),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    acpSessionId: text("acp_session_id"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    tokensCacheRead: integer("tokens_cache_read").notNull().default(0),
    tokensCacheWrite: integer("tokens_cache_write").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0), // cumulative, from ACP usage_update
    ctxTokens: integer("ctx_tokens").notNull().default(0), // context size after the last turn; drives session rotation
    // Timeline comments after this are fed to the agent on its next prompt.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agent_sessions_ticket_agent").on(t.ticketId, t.agentId)],
);

// One row per agent turn: what it cost and how big the context was.
export const runs = pgTable("runs", {
  id: id(),
  agentSessionId: uuid("agent_session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  model: text("model").notNull().default(""),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  tokensCacheRead: integer("tokens_cache_read").notNull().default(0),
  tokensCacheWrite: integer("tokens_cache_write").notNull().default(0),
  ctxTokens: integer("ctx_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  outcome: text("outcome").notNull(), // ACP stopReason, or "error"
  createdAt: createdAt(),
});

export const comments = pgTable("comments", {
  id: id(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }), // null = human/system
  parentId: uuid("parent_id"), // reply thread root
  linearCommentId: text("linear_comment_id"),
  kind: text("kind").notNull(), // CommentKind
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

// Org knowledge base. Agents write via MCP (kb_add); users via Settings.
export const knowledge = pgTable("knowledge", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").$type<import("@zippy/shared").KnowledgeInput["kind"]>().notNull(),
  text: text("text").notNull(),
  url: text("url").notNull().default(""),
  pinned: boolean("pinned").notNull().default(false),
  source: text("source").$type<"user" | "agent">().notNull().default("user"),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  uses: integer("uses").notNull().default(0), // times injected or confirmed; ranks ties
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// Recurring tickets: every `everyHours` a ticket is created from this template.
export const terminalTemplates = pgTable("terminal_templates", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  steps: jsonb("steps").$type<{ workspaceId: string; title: string; command: string; delaySec?: number }[]>().notNull().default([]),
  createdAt: createdAt(),
});

export const routines = pgTable("routines", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  workspaceIds: uuid("workspace_ids").array().notNull().default([]),
  assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
  pipelineId: uuid("pipeline_id").references(() => pipelines.id, { onDelete: "set null" }),
  everyHours: integer("every_hours").notNull().default(24),
  runAt: text("run_at"),
  enabled: boolean("enabled").notNull().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// Per-day dev todos. `day` is the work day (profile.dayStart), so past days are just earlier keys.
export const todos = pgTable("todos", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  day: text("day").notNull(),
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull().default(""),
  ref: text("ref").notNull().default(""),
  done: boolean("done").notNull().default(false),
  createdAt: createdAt(),
});

// Trending tech news, refreshed from public feeds (news.ts). Global, not per org.
// rank = position in the source's latest feed; null = dropped from the feed but kept because saved.
export const news = pgTable("news", {
  id: id(),
  source: text("source").$type<import("../news.ts").Source>().notNull(),
  title: text("title").notNull(),
  url: text("url").notNull().unique(),
  summary: text("summary").notNull().default(""),
  score: integer("score").notNull().default(0),
  rank: integer("rank"),
  saved: boolean("saved").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  readMinutes: integer("read_minutes"), // null = not an article or page unreadable
  createdAt: createdAt(),
});
