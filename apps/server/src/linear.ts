import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import type { TicketStatus } from "@zippy/shared";
import { db, orgs, tickets } from "./db/index.ts";

export const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";
const redirectUri = () => `http://127.0.0.1:${process.env.PORT ?? 3001}/api/linear/callback`;

type Org = typeof orgs.$inferSelect;
type Ticket = typeof tickets.$inferSelect;
export type LinearAuth = { client?: any; tokens?: any; verifier?: string; discovery?: any };

// Linear MCP's own OAuth (dynamic client registration): no Linear app or client secret.
const pendingStates = new Map<string, string>(); // state -> orgId

function provider(orgId: string, onRedirect?: (url: URL) => void): OAuthClientProvider {
  const load = async () => ((await db.select({ a: orgs.linearAuth }).from(orgs).where(eq(orgs.id, orgId)))[0]?.a ?? {}) as LinearAuth;
  const save = async (patch: LinearAuth) => {
    await db.update(orgs).set({ linearAuth: { ...(await load()), ...patch } }).where(eq(orgs.id, orgId));
  };
  return {
    get redirectUrl() {
      return redirectUri();
    },
    get clientMetadata() {
      return { client_name: "Zippy", redirect_uris: [redirectUri()], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
    },
    state() {
      const s = randomUUID();
      pendingStates.set(s, orgId);
      return s;
    },
    clientInformation: async () => (await load()).client,
    saveClientInformation: (client) => save({ client }),
    tokens: async () => (await load()).tokens,
    saveTokens: (tokens) => save({ tokens }),
    saveCodeVerifier: (verifier) => save({ verifier }),
    codeVerifier: async () => (await load()).verifier!,
    discoveryState: async () => (await load()).discovery,
    saveDiscoveryState: (discovery) => save({ discovery }),
    redirectToAuthorization: (url) => onRedirect?.(url),
  };
}

export async function authorizeUrl(orgId: string) {
  let url: URL | undefined;
  await auth(provider(orgId, (u) => (url = u)), { serverUrl: LINEAR_MCP_URL });
  return url?.toString() ?? `${process.env.WEB_URL ?? "http://localhost:5199"}/settings?linear=connected`;
}

export async function completeOAuth(code: string, state: string) {
  const orgId = pendingStates.get(state);
  if (!orgId) throw new Error("Unknown OAuth state. Start the connection again.");
  pendingStates.delete(state);
  await auth(provider(orgId), { serverUrl: LINEAR_MCP_URL, authorizationCode: code });
  clients.delete(orgId);
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  const { name } = await call<{ name: string }>(org!, "get_workspace");
  await db.update(orgs).set({ linearWorkspace: name }).where(eq(orgs.id, orgId));
  return orgId;
}

// One MCP client per org; the transport refreshes the token on 401.
const clients = new Map<string, Promise<Client>>();
export const dropClient = (orgId: string) => clients.delete(orgId);

function client(org: Org) {
  let c = clients.get(org.id);
  if (!c) {
    c = (async () => {
      const cl = new Client({ name: "zippy", version: "0.1.0" });
      await cl.connect(new StreamableHTTPClientTransport(new URL(LINEAR_MCP_URL), { authProvider: provider(org.id) }));
      return cl;
    })();
    c.catch(() => clients.delete(org.id));
    clients.set(org.id, c);
  }
  return c;
}

async function call<T>(org: Org, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = (await (await client(org)).callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  if (res.isError) throw new Error(`Linear: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** Fresh access token for agents' Linear MCP header. Pings first so an expired token refreshes. */
export async function agentToken(org: Org) {
  if (!(org.linearAuth as LinearAuth | null)?.tokens) return null;
  await (await client(org)).ping();
  return ((await provider(org.id).tokens()) as { access_token: string } | undefined)?.access_token ?? null;
}

const connected = (org: Org, ticket: Ticket) => !!(org.linearAuth as LinearAuth | null)?.tokens && !!ticket.linearId;

type Issue = { uuid: string; id: string; title: string; description: string | null; url: string; labels: string[] };
type LinearComment = { id: string; body: string; createdAt: string; parentId: string | null; author: { name: string } | null };

/** Accepts COM-123 or a linear.app issue URL. */
export async function fetchIssue(org: Org, ref: string) {
  const id = /([A-Z][A-Z0-9]+-\d+)/.exec(ref)?.[1];
  if (!id) throw new Error("Use an issue ID like COM-123 or a Linear issue URL.");
  const issue = await call<Issue>(org, "get_issue", { id });
  const { comments } = await call<{ comments: LinearComment[] }>(org, "list_comments", { issueId: id, limit: 250, orderBy: "createdAt" });
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    ...issue,
    // ponytail: MCP gives label names only, so new labels get one color.
    labels: { nodes: issue.labels.map((name) => ({ name, color: "#6b7280" })) },
    comments: { nodes: comments.map((c) => ({ ...c, user: c.author, parent: c.parentId ? { id: c.parentId } : null })) },
  };
}

// Comments we posted, so the webhook does not echo them back. ponytail: in-memory, lost on restart.
export const ownCommentIds = new Set<string>();

// MCP posts as the connected user, so the agent's name goes in the body.
export async function postComment(org: Org, ticket: Ticket, body: string, author: string, parentId?: string | null) {
  if (!connected(org, ticket)) return;
  const c = await call<{ id?: string }>(org, "save_comment", parentId ? { parentId, body: `**${author}:** ${body}` } : { issueId: ticket.linearId, body: `**${author}:** ${body}` });
  if (c?.id) ownCommentIds.add(c.id);
  return c?.id;
}

// Zippy status -> Linear state names to try, then state type. null = leave Linear as is.
const STATE_MAP: Partial<Record<TicketStatus, string[]>> = {
  backlog: ["Backlog", "backlog"],
  todo: ["Todo", "unstarted"],
  in_progress: ["In Progress", "started"],
  in_review: ["In Review"],
  done: ["Done", "completed"],
  canceled: ["Canceled", "Cancelled", "canceled"],
};

export async function syncStatus(org: Org, ticket: Ticket, status: TicketStatus) {
  const want = STATE_MAP[status];
  if (!connected(org, ticket) || !want) return;
  let err;
  for (const state of want) {
    try {
      return await call(org, "save_issue", { id: ticket.linearId, state });
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

export async function attachPr(org: Org, ticket: Ticket, url: string, title: string) {
  if (!connected(org, ticket)) return;
  await call(org, "save_issue", { id: ticket.linearId, links: [{ url, title }] });
}

export function verifyWebhook(raw: string, signature: string | undefined) {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const got = Buffer.from(signature, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}
