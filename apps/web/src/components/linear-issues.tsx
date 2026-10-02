import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import { useNavigate } from "react-router";
import type { Ticket } from "@zippy/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, keys, queryClient, useTickets, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { useUI } from "@/lib/store";
import { cn } from "@/lib/utils";

type LinearIssue = {
  uuid: string;
  id: string;
  title: string;
  description?: string | null;
  url: string;
  status: string;
  priority?: { name: string };
  assignee?: string | null;
};

/** Linear issues assigned to / mentioning the user. Select one to preview, float button imports it. */
export function LinearIssues() {
  const org = useOrg();
  const navigate = useNavigate();
  const { linearUser, setLinearUser } = useUI();
  const [draft, setDraft] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: tickets = [] } = useTickets(org.id);
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const [status, setStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const listKey = keys.res(org.id, `linear-issues-${linearUser}`);
  const listPath = `/orgs/${org.id}/linear/issues?user=${encodeURIComponent(linearUser)}`;
  const { data: all = { at: 0, issues: [] }, isLoading, error } = useQuery({
    queryKey: listKey,
    queryFn: () => api.get<{ at: number; issues: LinearIssue[] }>(listPath),
    enabled: !!linearUser,
    staleTime: 30 * 60_000,
  });
  const statuses = [...new Set(all.issues.map((i) => i.status))];
  const issues = status ? all.issues.filter((i) => i.status === status) : all.issues;

  async function refresh() {
    setRefreshing(true);
    try {
      queryClient.setQueryData(listKey, await api.get(`${listPath}&fresh=1`));
    } finally {
      setRefreshing(false);
    }
  }

  if (!linearUser)
    return (
      <form
        className="grid place-items-center gap-3 p-20 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) setLinearUser(draft.trim());
        }}
      >
        <p className="text-muted-foreground">
          Enter your Linear username to list issues assigned to or mentioning
          you.
        </p>
        <div className="flex gap-2">
          <input
            aria-label="Linear username"
            placeholder="username"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="bg-background h-8 rounded-md border px-2 outline-none"
            autoFocus
          />
          <Button size="sm" type="submit" disabled={!draft.trim()}>
            Save
          </Button>
        </div>
      </form>
    );

  const { data: full, isFetching } = useQuery({
    queryKey: keys.res(org.id, `linear-issue-${sel}`),
    queryFn: () => api.get<LinearIssue>(`/orgs/${org.id}/linear/issues/${sel}`),
    enabled: !!sel,
    staleTime: 30 * 60_000,
  });
  const current = all.issues.find((i) => i.id === sel);
  const imported = (id: string) => tickets.some((t) => t.identifier === id);

  async function bring() {
    if (!current || busy) return;
    setBusy(true);
    try {
      const t = await api.post<Ticket>(`/orgs/${org.id}/linear/import`, {
        ref: current.id,
        workspaceIds: workspaces[0] ? [workspaces[0].id] : [],
      });
      queryClient.invalidateQueries({ queryKey: keys.res(org.id, "tickets") });
      navigate(`/t/${t.identifier}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="text-muted-foreground flex h-9 items-center gap-2 border-b px-4 text-xs">
          Assigned to or mentioning{" "}
          <span className="text-foreground font-medium">{linearUser}</span>
          <button
            className="underline underline-offset-4"
            onClick={() => setLinearUser("")}
          >
            change
          </button>
          <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="bg-background ml-auto h-6 rounded-md border px-1">
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <button aria-label="Refresh from Linear" title={all.at ? `Cached ${new Date(all.at).toLocaleTimeString()}. Click to refetch.` : "Refetch"} onClick={refresh} disabled={refreshing} className="hover:text-foreground rounded p-1">
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
          </button>
        </div>
        {isLoading && (
          <div className="grid gap-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        )}
        {error && (
          <p className="text-destructive p-4 text-[13px]">{error.message}</p>
        )}
        {!isLoading && !error && !issues.length && (
          <p className="text-muted-foreground p-20 text-center text-[13px]">
            No Linear issues found.
          </p>
        )}
        <ul>
          {issues.map((i) => (
            <li key={i.id}>
              <button
                onClick={() => setSel(i.id)}
                className={cn(
                  "hover:bg-accent/50 border-border/60 flex h-11 w-full items-center gap-3 border-b px-4 text-left text-[13px]",
                  sel === i.id && "bg-accent",
                )}
              >
                <span className="text-muted-foreground w-20 shrink-0 font-mono text-xs">
                  {i.id}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {i.title}
                </span>
                {imported(i.id) && (
                  <span className="text-muted-foreground text-xs">
                    In Zippy
                  </span>
                )}
                <span className="text-muted-foreground text-xs">
                  {i.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {current && (
        <aside className="hidden w-[420px] shrink-0 overflow-y-auto border-l p-4 lg:block">
          <div className="text-muted-foreground mb-1 flex items-center gap-2 font-mono text-xs">
            {current.id}
            <a
              href={current.url}
              target="_blank"
              rel="noreferrer"
              aria-label="Open in Linear"
              className="hover:text-foreground"
            >
              <ExternalLink className="size-3" />
            </a>
          </div>
          <h2 className="mb-3 text-base font-medium">{current.title}</h2>
          <div className="md text-[13px]">
            <Markdown>
              {isFetching && !full
                ? "Loading…"
                : full?.description || "_No description._"}
            </Markdown>
          </div>
        </aside>
      )}
      <Button
        className="fixed right-6 bottom-6 z-20 rounded-full shadow-lg"
        disabled={!current || imported(current.id) || busy}
        onClick={bring}
      >
        <ArrowDownToLine className="size-4" aria-hidden />
        {current && imported(current.id)
          ? "Already in Zippy"
          : "Bring to Zippy"}
      </Button>
    </div>
  );
}
