import { z } from "zod";

export const TICKET_STATUSES = ["backlog", "todo", "in_progress", "needs_input", "in_review", "done", "blocked", "canceled"] as const;
export const ticketStatus = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof ticketStatus>;

export const MODELS = ["default", "opus", "sonnet", "haiku", "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"];
export const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];

export const HUMAN = "human"; // assignee picker value for the profile's human

export const PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

const handle = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, "lowercase letters, digits, dashes");

/** Skill/MCP on-off switches by catalog id (`skill:x`, `mcp:x`). Agent value overrides org value. */
const toggles = z.record(z.string(), z.boolean()).default({});

/** Prompt rules an agent can switch on/off (toggle key `rule:<id>`). `blocks` = tools denied while on. */
export const RULES: { id: string; name: string; description: string; text: string; defaultOn: boolean; blocks?: string[] }[] = [
  { id: "terse", name: "Terse replies", description: "Short, simple words. Lead with the answer.", defaultOn: true, text: "Everything you post is read by the user. Keep it terse. Use simple words (close to ASD-STE100). Lead with the answer. Do not narrate tool calls or your own thinking." },
  { id: "never-assume", name: "Never assume", description: "Gather context with skills and MCP, then ask the human.", defaultOn: true, text: "Never assume. If something is unclear, first gather context with your skills and MCP tools. If that is not enough, ask the human. Give options and your recommendation." },
  { id: "humanizer", name: "Humanize output", description: "Run the final text through the humanizer skill.", defaultOn: false, text: "Run your final text through the humanizer skill before you reply." },
  { id: "tag-human", name: "Tag the human", description: "Mention you by ID on comments and issues (Zippy, Linear, GitHub).", defaultOn: false, text: "When you write a comment, issue or PR text anywhere (Zippy, Linear, GitHub) and need the human's attention, tag them with their IDs from \"The human\"." },
  {
    id: "no-status-change",
    name: "Never change status",
    description: "Blocks handoff, sub-ticket creation and Linear issue updates.",
    defaultOn: false,
    text: "Do not change ticket status, issue state, or any other record.",
    blocks: ["mcp__zippy__handoff", "mcp__zippy__create_subtickets", "mcp__claude_ai_Linear__save_issue"],
  },
];

/** The human using Zippy. Git identity is used for agent commits. */
export const profileInput = z.object({
  name: z.string().max(80).default(""),
  handle: z.union([z.literal(""), handle]).default(""), // without "@"
  role: z.string().max(80).default(""),
  githubUsername: z.string().regex(/^[A-Za-z0-9-]{0,39}$/, "letters, digits, dashes").default(""),
  githubEmail: z.union([z.literal(""), z.email("an email address")]).default(""),
  linearUser: z.string().default(""),
  about: z.string().max(2000).default(""), // working style, shown to agents
});
export type Profile = z.infer<typeof profileInput>;

export const orgInput = z.object({
  name: z.string().min(1).max(80),
  key: z.string().regex(/^[A-Z]{2,6}$/, "2-6 uppercase letters"),
  contextMd: z.string().default(""),
  defaultModel: z.string().default("default"),
  defaultEffort: z.string().default("default"),
  budgetUsd: z.number().positive().nullable().default(null),
  slackWebhookUrl: z.union([z.literal(""), z.string().startsWith("https://hooks.slack.com/", "a Slack incoming webhook URL")]).default(""),
  notifyDesktop: z.boolean().default(true),
  useActiveBranch: z.boolean().default(false),
  linearPush: z.boolean().default(true), // push status/comments/PR links to Linear
  profile: profileInput.default(() => profileInput.parse({})),
  toggles,
});

export const orgCreate = orgInput.extend({ agents: z.array(z.string()).optional() }); // handles from the default library; omitted = all

export const workspaceInput = z.object({
  name: z.string().min(1).max(80),
  path: z.string().startsWith("/", "absolute path"),
  baseBranch: z.string().default("main"),
  setupCmd: z.string().default(""),
  testCmd: z.string().default(""),
  contextMd: z.string().default(""),
  riskPaths: z.array(z.string().min(1)).default([]),
});

export const mcpServerInput = z.object({
  name: z.string().min(1).max(60),
  workspaceIds: z.array(z.string().uuid()).default([]),
  transport: z.enum(["stdio", "http"]),
  command: z.string().default(""),
  args: z.array(z.string()).default([]),
  url: z.string().default(""),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});

export const agentInput = z.object({
  name: z.string().min(1).max(60),
  handle,
  rolePromptMd: z.string().default(""),
  model: z.string().default("default"),
  canWrite: z.boolean().default(false),
  color: z.string().default("#6366f1"),
  toggles,
});

export const ticketInput = z.object({
  title: z.string().min(1).max(200),
  body: z.string().default(""),
  workspaceIds: z.array(z.string().uuid()).default([]),
  assigneeAgentId: z.string().uuid().nullable().default(null),
  assigneeHuman: z.boolean().optional(), // the profile's human; excludes an agent assignee
  priority: z.enum(PRIORITIES).default("none"),
  labelIds: z.array(z.string().uuid()).default([]),
  status: ticketStatus.default("todo"),
});

/** PATCH schema: every field optional, defaults dropped. zod 4 still applies defaults inside .partial(), which would reset unsent fields. */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, ((v instanceof z.ZodDefault ? v.unwrap() : v) as z.ZodType).optional()]));
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }>;
}

export const ticketPatch = patchOf(ticketInput).extend({ archived: z.boolean().optional() });

export const commentInput = z.object({ body: z.string().min(1), parentId: z.string().uuid().nullable().default(null) });

export const labelInput = z.object({ name: z.string().min(1).max(40), color: z.string().default("#6b7280") });

export const stageInput = z.object({
  name: z.string().min(1).max(60),
  agentId: z.string().uuid(),
  instruction: z.string().default(""),
  onPass: z.string().default("next"), // "next" | "done" | stage position as string
  onFail: z.string().default("human"), // "human" | stage position as string
  humanGate: z.boolean().default(false),
});

export const pipelineInput = z.object({
  name: z.string().min(1).max(80),
  autoStart: z.boolean().default(false),
  maxLoops: z.number().int().min(1).max(10).default(3),
  stages: z.array(stageInput).min(1),
});

export const linearImport = z.object({
  ref: z.string().min(1), // URL or identifier like COM-123
  workspaceIds: z.array(z.string().uuid()).default([]),
  assigneeAgentId: z.string().uuid().nullable().default(null),
});

export const routineInput = z.object({
  name: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  body: z.string().default(""),
  workspaceIds: z.array(z.string().uuid()).default([]),
  assigneeAgentId: z.string().uuid().nullable().default(null),
  pipelineId: z.string().uuid().nullable().default(null),
  everyHours: z.number().int().min(1).max(24 * 30).default(24),
  runAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM").nullable().default(null), // local time of day; days = ceil(everyHours / 24)
  enabled: z.boolean().default(true),
});

type RunTimes = { everyHours: number; runAt: string | null; lastRunAt: string | Date | null; createdAt: string | Date };
export function nextRunAt(r: RunTimes): Date {
  const base = new Date(r.lastRunAt ?? r.createdAt);
  if (!r.runAt) return new Date(+base + r.everyHours * 36e5);
  const [h, m] = r.runAt.split(":").map(Number);
  const d = new Date(base);
  d.setHours(h!, m, 0, 0);
  if (r.lastRunAt) d.setDate(d.getDate() + Math.ceil(r.everyHours / 24));
  else if (d < base) d.setDate(d.getDate() + 1);
  return d;
}

export const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), "http(s) URL");
export const KB_KINDS = ["do", "dont", "prefer", "fact", "command", "link"] as const;
export const KB_LABELS: Record<(typeof KB_KINDS)[number], string> = { do: "Do", dont: "Don't", prefer: "Prefer", fact: "Fact", command: "Command", link: "Link" };
export const knowledgeInput = z.object({
  kind: z.enum(KB_KINDS),
  text: z.string().trim().min(1).max(500),
  url: z.union([z.literal(""), httpUrl]).default(""),
  workspaceId: z.string().uuid().nullable().default(null), // null = whole org
  pinned: z.boolean().default(false), // always injected into prompts
});

export const approvalDecision =z.object({ optionId: z.string().nullable() });

export type CatalogItem = { id: string; kind: "skill" | "mcp"; name: string; description: string; source: string; defaultOn: boolean };
export type Preset = { id: string; name: string; description: string; installed: boolean };
export type Catalog = { items: CatalogItem[]; presets: Preset[] };

export type OrgInput = z.infer<typeof orgInput>;
export type WorkspaceInput = z.infer<typeof workspaceInput>;
export type McpServerInput = z.infer<typeof mcpServerInput>;
export type AgentInput = z.infer<typeof agentInput>;
export type StageInput = z.infer<typeof stageInput>;
export type PipelineInput = z.infer<typeof pipelineInput>;
export type TicketInput = z.infer<typeof ticketInput>;
export type RoutineInput = z.infer<typeof routineInput>;

export type CommentKind = "text" | "tool" | "plan" | "approval" | "status" | "error" | "handoff" | "question" | "pr" | "stage" | "test" | "learning";

// Comment payloads by kind.
export type TextPayload = { text: string; author?: string }; // author: Linear user name for synced comments
export type ToolPayload = { toolCallId: string; title: string; kind?: string; status?: string; output?: string };
export type PlanPayload = { entries: { content: string; status: string; priority?: string }[] };
export type ApprovalPayload = {
  title: string;
  kind?: string;
  options: { optionId: string; name: string; kind: string }[];
  decision?: string | null;
};
export type StatusPayload = { from?: string; to: string };
export type HandoffPayload = { verdict: "pass" | "fail"; summary: string; notes?: string; stage: string; next?: string };
export type QuestionPayload = { question: string; options: string[]; recommended?: string; answer?: string; action?: "risk" }; // risk: first option approves protected-path PRs
export type PrPayload = { url: string; title: string };
export type StagePayload = { name: string; loop: number };
export type LearningPayload = { text: string; workspaceId: string | null; status?: "accepted" | "dismissed" }; // workspaceId null = org context
export type TestPayload = { folder: string; command: string; ok: boolean; output: string; durationMs: number };

export type DiffFile = { path: string; additions: number; deletions: number; risky: boolean; patch: string };
export type FolderDiff = { workspaceId: string; folder: string; branch: string | null; base: string; files: DiffFile[]; error?: string; merged?: boolean }; // merged: branch tip already in base

export type InboxItem = {
  kind: "question" | "approval" | "gate" | "review" | "blocked" | "learning";
  ticket: Pick<Ticket, "id" | "identifier" | "title" | "status">;
  commentId?: string;
  agentId: string | null;
  title: string;
  detail?: string;
  options?: { id: string; label: string; primary?: boolean }[];
  createdAt: string;
};

export const AGENT_HANDLE_RE = /(?:^|\s)@([a-z][a-z0-9-]{1,30})\b/g;

export function mentionedHandles(body: string): string[] {
  return [...body.matchAll(AGENT_HANDLE_RE)].map((m) => m[1]!);
}

export type TicketEvent =
  | { type: "comment"; comment: unknown }
  | { type: "delta"; id: string; text: string }
  | { type: "ticket"; ticket: unknown }
  | { type: "session"; agentId: string; running: boolean };

// Row shapes as served by the API (dates are ISO strings).
type Row = { id: string; createdAt: string };
export type Org = Row & OrgInput & { ticketSeq: number; linearConnected: boolean; linearWorkspace: string | null };
export type Workspace = Row & WorkspaceInput & { orgId: string };
export type McpServer = Row & McpServerInput & { orgId: string };
export type Agent = Row & AgentInput & { orgId: string };
export type TicketFolder = {
  workspaceId: string;
  position: number;
  worktreePath: string | null;
  branch: string | null;
  prUrl: string | null;
  prTitle: string | null;
  prState: string | null;
  ciHandledSha: string | null;
  reviewSeenAt: string | null;
};
export type Ticket = Row &
  Omit<TicketInput, "workspaceIds"> & {
    orgId: string;
    identifier: string;
    linearId: string | null;
    linearUrl: string | null;
    pipelineId: string | null;
    routineId: string | null;
    stageId: string | null;
    loopCount: number;
    riskApproved: boolean;
    archived: boolean;
    parentId: string | null;
    updatedAt: string;
    folders: TicketFolder[];
  };
export type Routine = Row & RoutineInput & { orgId: string; lastRunAt: string | null };
export type Label = Row & z.infer<typeof labelInput> & { orgId: string };
export type KnowledgeInput = z.infer<typeof knowledgeInput>;
export type Knowledge = Row & KnowledgeInput & { orgId: string; source: "user" | "agent"; agentId: string | null; ticketId: string | null; uses: number; lastUsedAt: string | null };
export type RelatedTicket = Pick<Ticket, "id" | "identifier" | "title" | "status">;
export type Stage = StageInput & { id: string; pipelineId: string; position: number };
export type Pipeline = Row & Omit<PipelineInput, "stages"> & { orgId: string; stages: Stage[] };
export type Comment = Row & { ticketId: string; agentId: string | null; parentId: string | null; kind: CommentKind; payload: unknown };
export type AgentSession = Row & { ticketId: string; agentId: string; acpSessionId: string | null; tokensIn: number; tokensOut: number; costUsd: number; running: boolean };
export type AgentWork = { ticket: Pick<Ticket, "id" | "identifier" | "title" | "status" | "updatedAt">; assigned: boolean; running: boolean; costUsd: number; tokens: number };
export type TicketDetail = { ticket: Ticket; comments: Comment[]; sessions: AgentSession[]; pipeline: Pipeline | null; related: RelatedTicket[]; parent: RelatedTicket | null; children: RelatedTicket[]; budgetUsd: number | null };

export const TICKET_ID_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;
