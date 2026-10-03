import { QueryClient, useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import type { Agent, AgentWork, Comment, FolderDiff, InboxItem, Knowledge, Label, McpServer, Org, OrgInput, Pipeline, Routine, Ticket, TicketDetail, TicketEvent, Workspace } from "@zippy/shared";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false },
    mutations: { onError: (e) => toast.error(e.message) },
  },
});

const OK: Record<string, string> = { POST: "Done", PATCH: "Saved", PUT: "Saved", DELETE: "Deleted" };

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.issues?.[0] ? `${err.issues[0].path.join(".")}: ${err.issues[0].message}` : (err.error ?? res.statusText)), { status: res.status });
  }
  if (method !== "GET" && !/sync$|pick-folder$/.test(path)) toast.success(body && typeof body === "object" && "archived" in body ? (body.archived ? "Issue archived" : "Issue unarchived") : OK[method]);
  return res.status === 204 || res.status === 202 ? (undefined as T) : res.json();
}

export const api = {
  get: <T,>(p: string) => http<T>("GET", p),
  post: <T,>(p: string, b: unknown = {}) => http<T>("POST", p, b),
  patch: <T,>(p: string, b: unknown) => http<T>("PATCH", p, b),
  put: <T,>(p: string, b: unknown) => http<T>("PUT", p, b),
  del: (p: string) => http<void>("DELETE", p),
};

const useApiQuery = <T,>(key: QueryKey, path: string | null) =>
  useQuery({ queryKey: key, queryFn: () => api.get<T>(path!), enabled: !!path });

/** Mutation that invalidates `invalidate` on success. */
export function useApiMutation<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k }))) });
}

export const keys = {
  system: ["system"],
  orgs: ["orgs"],
  res: (orgId: string, r: string) => ["org", orgId, r],
  ticket: (id: string) => ["ticket", id],
};

export const useSystem = () =>
  useQuery({ queryKey: keys.system, queryFn: () => api.get<{ claudePath: string | null; auth: { loggedIn: boolean; authMethod?: string } }>("/system") });
export const useAcp = () =>
  useQuery({ queryKey: ["system", "acp"], queryFn: () => api.get<{ ok: boolean; agent?: string; version?: string; error?: string }>("/system/acp"), staleTime: 60_000, retry: false });
export type Usage = Record<"five_hour" | "seven_day", { utilization: number; resets_at: string } | null>;
export const useUsage = () => useQuery({ queryKey: ["system", "usage"], queryFn: () => api.get<Usage | null>("/system/usage"), refetchInterval: 300_000, retry: false });
export const useOrgs = () => useApiQuery<Org[]>(keys.orgs, "/orgs");
export const useWorkspaces = (orgId?: string) => useApiQuery<Workspace[]>(keys.res(orgId!, "workspaces"), orgId ? `/orgs/${orgId}/workspaces` : null);
export const useMcpServers = (orgId?: string) => useApiQuery<McpServer[]>(keys.res(orgId!, "mcp"), orgId ? `/orgs/${orgId}/mcp` : null);
export const useAgents = (orgId?: string) => useApiQuery<Agent[]>(keys.res(orgId!, "agents"), orgId ? `/orgs/${orgId}/agents` : null);
export const useTickets = (orgId?: string) => useApiQuery<Ticket[]>(keys.res(orgId!, "tickets"), orgId ? `/orgs/${orgId}/tickets` : null);
export const useInbox = (orgId?: string) =>
  useQuery({ queryKey: keys.res(orgId!, "inbox"), queryFn: () => api.get<InboxItem[]>(`/orgs/${orgId}/inbox`), enabled: !!orgId, refetchInterval: 15_000 });
export const useDiff = (ticketId: string, enabled: boolean, merged = false) =>
  useQuery({ queryKey: ["diff", ticketId, merged], queryFn: () => api.get<FolderDiff[]>(`/tickets/${ticketId}/diff${merged ? "?merged=1" : ""}`), enabled, staleTime: 0 });
export const useKnowledge = (orgId?: string) => useApiQuery<Knowledge[]>(keys.res(orgId!, "knowledge"), orgId ? `/orgs/${orgId}/knowledge` : null);
export const useLabels = (orgId?: string) => useApiQuery<Label[]>(keys.res(orgId!, "labels"), orgId ? `/orgs/${orgId}/labels` : null);
export const usePipelines = (orgId?: string) => useApiQuery<Pipeline[]>(keys.res(orgId!, "pipelines"), orgId ? `/orgs/${orgId}/pipelines` : null);
export const useRoutines = (orgId?: string) => useApiQuery<Routine[]>(keys.res(orgId!, "routines"), orgId ? `/orgs/${orgId}/routines` : null);
export const useAgentWork = (agentId?: string) =>
  useQuery({ queryKey: ["agent-work", agentId], queryFn: () => api.get<AgentWork[]>(`/agents/${agentId}/work`), enabled: !!agentId, refetchInterval: 5000 });
export const useTicket = (id?: string) => useApiQuery<TicketDetail>(keys.ticket(id!), id ? `/tickets/${id}` : null);

export const createOrg = (v: OrgInput) => api.post<Org>("/orgs", v);

/** Live ticket updates: SSE events patch the cached TicketDetail in place. */
export function useTicketEvents(ticketId: string | undefined, orgId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!ticketId) return;
    const es = new EventSource(`/api/tickets/${ticketId}/events`);
    const patch = (fn: (d: TicketDetail) => TicketDetail) =>
      qc.setQueryData<TicketDetail>(keys.ticket(ticketId), (d) => (d ? fn(d) : d));
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as TicketEvent;
      if (e.type === "comment") {
        const c = e.comment as Comment;
        patch((d) => {
          const i = d.comments.findIndex((x) => x.id === c.id);
          return { ...d, comments: i < 0 ? [...d.comments, c] : d.comments.with(i, c) };
        });
      } else if (e.type === "delta") {
        patch((d) => ({
          ...d,
          comments: d.comments.map((c) =>
            c.id === e.id ? { ...c, payload: { text: (c.payload as { text: string }).text + e.text } } : c,
          ),
        }));
      } else if (e.type === "ticket") {
        patch((d) => ({ ...d, ticket: e.ticket as Ticket }));
        qc.invalidateQueries({ queryKey: keys.res(orgId, "tickets") });
      } else if (e.type === "session") {
        qc.invalidateQueries({ queryKey: keys.ticket(ticketId) });
      }
    };
    // EventSource reconnects on its own; refetch on reopen to fill any gap.
    es.onopen = () => qc.invalidateQueries({ queryKey: keys.ticket(ticketId) });
    return () => es.close();
  }, [ticketId, orgId, qc]);
}
